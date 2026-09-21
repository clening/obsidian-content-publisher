import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import * as https from "https";
import {
  SubstackDocument,
  SubstackDraftPayload,
  SubstackSection,
  SubstackAudience,
  ImageUploadResult
} from "./types";

export interface SubstackAPIOptions {
  /** Publication subdomain -> custom domain (e.g. "mypub" -> "news.example.com") */
  customDomains?: Record<string, string>;
  /** Substack user ID, used to credit new drafts to the author */
  userId?: number | null;
}

export interface SubstackPublicationInfo {
  subdomain: string;
  hasPaidSubscriptions: boolean;
  /** Set when the publication is served from a custom domain */
  customDomain?: string;
}

/**
 * Minimal HTTP GET that does not follow redirects and exposes Set-Cookie,
 * neither of which Obsidian's requestUrl allows.
 */
function rawGet(
  url: string,
  cookie?: string
): Promise<{ status: number; location: string | undefined; setCookie: string[] }> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: cookie ? { Cookie: cookie } : {} }, (res) => {
      res.resume();
      resolve({
        status: res.statusCode ?? 0,
        location: res.headers.location,
        setCookie: res.headers["set-cookie"] ?? []
      });
    });
    req.on("error", reject);
  });
}

export class SubstackAPI {
  private cookie: string;
  private customDomains: Record<string, string>;
  private userId: number | null;
  /** Session cookies for custom-domain publications, by subdomain */
  private customDomainSessions = new Map<string, string>();

  constructor(cookie: string, options: SubstackAPIOptions = {}) {
    this.cookie = this.normalizeCookie(cookie);
    this.customDomains = options.customDomains ?? {};
    this.userId = options.userId ?? null;
  }

  /**
   * Normalize cookie to ensure it has the correct format
   * User can input just the value or the full cookie string
   */
  private normalizeCookie(cookie: string): string {
    const trimmed = cookie.trim();

    // Already has a cookie name prefix
    if (trimmed.includes("=")) {
      return trimmed;
    }

    // Just the value - add substack.sid prefix
    return `substack.sid=${trimmed}`;
  }

  private getHost(publication: string): string {
    return this.customDomains[publication] || `${publication}.substack.com`;
  }

  private getBaseUrl(publication: string): string {
    return `https://${this.getHost(publication)}/api/v1`;
  }

  /**
   * Publications on a custom domain redirect every *.substack.com request to
   * that domain, which does not accept the substack.com session cookie.
   * Substack's cross-domain sign-in hands out a session for the custom domain
   * (connect.sid) in exchange for the substack.com one.
   */
  private async getCustomDomainSession(
    publication: string,
    domain: string
  ): Promise<string> {
    const cached = this.customDomainSessions.get(publication);
    if (cached) return cached;

    const signIn = await rawGet(
      `https://substack.com/sign-in?redirect=%2F&for_pub=${encodeURIComponent(publication)}`,
      this.cookie
    );
    if (!signIn.location || !signIn.location.includes(domain)) {
      throw new Error(
        `Custom domain sign-in failed (status ${signIn.status}). Your Substack session may have expired.`
      );
    }

    const complete = await rawGet(signIn.location);
    const session = complete.setCookie
      .map((c) => c.split(";")[0] ?? "")
      .find((c) => c.startsWith("connect.sid="));
    if (!session) {
      throw new Error("Custom domain sign-in returned no session cookie.");
    }

    this.customDomainSessions.set(publication, session);
    return session;
  }

  /**
   * Send a request to a publication, authenticating against its custom domain if it has one.
   */
  private async publicationRequest(
    publication: string,
    params: RequestUrlParam
  ): Promise<RequestUrlResponse> {
    const domain = this.customDomains[publication];
    if (!domain) {
      return requestUrl(params);
    }

    const send = async () =>
      requestUrl({
        ...params,
        headers: {
          ...params.headers,
          Cookie: await this.getCustomDomainSession(publication, domain)
        }
      });

    const response = await send();
    if (response.status === 401 || response.status === 403) {
      // The custom-domain session may have expired; get a fresh one and retry once
      this.customDomainSessions.delete(publication);
      return send();
    }
    return response;
  }

  private getHeaders(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Cookie: this.cookie
    };
  }

  /**
   * Get user profile with publications list
   * Returns the list of publication subdomains the user owns
   */
  async getUserPublications(): Promise<string[]> {
    const pubs = await this.getUserPublicationsWithInfo();
    return pubs.map((p) => p.subdomain);
  }

  /**
   * Get user publications with additional info (including paid status)
   */
  async getUserPublicationsWithInfo(): Promise<SubstackPublicationInfo[]> {
    const response = await requestUrl({
      url: "https://substack.com/api/v1/user/profile/self",
      method: "GET",
      headers: this.getHeaders(),
      throw: false
    });

    if (response.status >= 200 && response.status < 300 && response.json) {
      const profile = response.json as {
        id?: number;
        publicationUsers?: Array<{
          publication?: {
            subdomain?: string;
            custom_domain?: string | null;
            custom_domain_optional?: boolean;
            has_subscriber_only_content?: boolean;
            stripe_publishable_key?: string;
            stripe_country?: string;
            default_coupon?: unknown;
            // Debug: log full publication object to console
          };
        }>;
      };

      if (typeof profile.id === "number") {
        this.userId = profile.id;
      }

      if (profile.publicationUsers) {
        return profile.publicationUsers
          .map((pu) => {
            const info: SubstackPublicationInfo = {
              subdomain: pu.publication?.subdomain || "",
              // Check for indicators of paid subscriptions being enabled
              hasPaidSubscriptions: !!(
                pu.publication?.stripe_publishable_key ||
                pu.publication?.has_subscriber_only_content
              )
            };
            // When the custom domain is optional, the substack.com address still works
            if (
              pu.publication?.custom_domain &&
              !pu.publication.custom_domain_optional
            ) {
              info.customDomain = pu.publication.custom_domain;
            }
            return info;
          })
          .filter((p) => p.subdomain !== "");
      }
    }

    return [];
  }

  /**
   * Substack user ID, known after getUserPublicationsWithInfo() or when passed in options
   */
  getUserId(): number | null {
    return this.userId;
  }

  async createDraft(
    publication: string,
    title: string,
    body: SubstackDocument,
    subtitle?: string,
    audience: SubstackAudience = "everyone",
    tags?: string[]
  ): Promise<RequestUrlResponse> {
    const payload: Record<string, unknown> = {
      draft_title: title,
      draft_subtitle: subtitle || "",
      draft_body: JSON.stringify(body),
      draft_bylines:
        this.userId !== null ? [{ id: this.userId, is_guest: false }] : [],
      audience,
      type: "newsletter",
      section_chosen: false,
      write_comment_permissions: "everyone"
    };

    // Add tags if provided
    if (tags && tags.length > 0) {
      payload.postTags = tags;
    }

    const url = `${this.getBaseUrl(publication)}/drafts`;

    const response = await this.publicationRequest(publication, {
      url,
      method: "POST",
      headers: this.getHeaders(),
      body: JSON.stringify(payload),
      throw: false
    });

    return response;
  }

  /**
   * Get available sections for a publication
   */
  async getSections(publication: string): Promise<SubstackSection[]> {
    const response = await this.publicationRequest(publication, {
      url: `${this.getBaseUrl(publication)}/publication/sections`,
      method: "GET",
      headers: this.getHeaders(),
      throw: false
    });

    if (response.status >= 200 && response.status < 300 && response.json) {
      const sections = response.json as
        | SubstackSection[]
        | { sections?: SubstackSection[] };

      if (Array.isArray(sections)) {
        return sections;
      }
      if (sections.sections) {
        return sections.sections;
      }
    }

    return [];
  }

  /**
   * Update draft with section
   */
  async updateDraftSection(
    publication: string,
    draftId: string,
    sectionId: number
  ): Promise<RequestUrlResponse> {
    return this.updateDraft(publication, draftId, {
      draft_section_id: sectionId,
      section_chosen: true
    } as unknown as Partial<SubstackDraftPayload>);
  }

  async publishDraft(
    publication: string,
    draftId: string
  ): Promise<RequestUrlResponse> {
    const response = await this.publicationRequest(publication, {
      url: `${this.getBaseUrl(publication)}/drafts/${draftId}/publish`,
      method: "POST",
      headers: this.getHeaders(),
      throw: false
    });

    return response;
  }

  async listDrafts(publication: string): Promise<RequestUrlResponse> {
    const response = await this.publicationRequest(publication, {
      url: `${this.getBaseUrl(publication)}/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc`,
      method: "GET",
      headers: this.getHeaders(),
      throw: false
    });

    return response;
  }

  async updateDraft(
    publication: string,
    draftId: string,
    updates: Partial<SubstackDraftPayload>
  ): Promise<RequestUrlResponse> {
    const response = await this.publicationRequest(publication, {
      url: `${this.getBaseUrl(publication)}/drafts/${draftId}`,
      method: "PUT",
      headers: this.getHeaders(),
      body: JSON.stringify(updates),
      throw: false
    });

    return response;
  }

  async getDraft(
    publication: string,
    draftId: string
  ): Promise<RequestUrlResponse> {
    const response = await this.publicationRequest(publication, {
      url: `${this.getBaseUrl(publication)}/drafts/${draftId}`,
      method: "GET",
      headers: this.getHeaders(),
      throw: false
    });

    return response;
  }

  updateCookie(newCookie: string): void {
    this.cookie = this.normalizeCookie(newCookie);
  }

  /**
   * Upload an image to Substack CDN
   * @param publication - The publication subdomain
   * @param imageData - Binary image data as ArrayBuffer
   * @param _filename - Original filename with extension (unused by Substack API but kept for interface parity)
   * @param mimeType - MIME type (image/png, image/jpeg, etc.)
   * @returns Image upload result with CDN URL
   */
  async uploadImage(
    publication: string,
    imageData: ArrayBuffer,
    _filename: string,
    mimeType: string
  ): Promise<{ success: boolean; data?: ImageUploadResult; error?: string }> {
    // Convert ArrayBuffer to base64 data URI
    const uint8Array = new Uint8Array(imageData);
    let binary = "";
    for (let i = 0; i < uint8Array.length; i++) {
      binary += String.fromCharCode(uint8Array[i] as number);
    }
    const base64 = activeWindow.btoa(binary);
    const dataUri = `data:${mimeType};base64,${base64}`;

    // Substack expects form-urlencoded with "image" field containing data URI
    const response = await this.publicationRequest(publication, {
      url: `${this.getBaseUrl(publication)}/image`,
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Cookie: this.cookie
      },
      body: `image=${encodeURIComponent(dataUri)}`,
      throw: false
    });

    if (response.status >= 200 && response.status < 300) {
      return {
        success: true,
        data: response.json as ImageUploadResult
      };
    }

    return {
      success: false,
      error: `Upload failed: ${response.status} - ${response.text || "Unknown error"}`
    };
  }
}

// Re-export types for convenience
export type {
  SubstackDocument,
  SubstackDraftPayload,
  SubstackDraftResponse,
  SubstackSection,
  SubstackAudience,
  SubstackFrontmatter,
  ImageUploadResult
} from "./types";
