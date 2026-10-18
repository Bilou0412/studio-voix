// Canal B de la spec : les fichiers passent par les releases d'un dépôt GitHub privé,
// joignable depuis l'espace de travail de Claude.
export class GithubReleases {
  constructor(
    private token: string,
    public repo: string,
    private api = "https://api.github.com",
  ) {}

  private async gh(url: string, init: RequestInit = {}) {
    const res = await fetch(url.startsWith("http") ? url : `${this.api}${url}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.token}`,
        "x-github-api-version": "2022-11-28",
        accept: "application/vnd.github+json",
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  async ensureRelease(tag: string, body = ""): Promise<{ id: number; upload_url: string; assets: { id: number; name: string; url: string }[] }> {
    const got = await this.gh(`/repos/${this.repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (got.ok) return got.json();
    if (got.status !== 404) throw new Error(`GitHub ${got.status} : ${await got.text()}`);
    const made = await this.gh(`/repos/${this.repo}/releases`, {
      method: "POST",
      body: JSON.stringify({ tag_name: tag, name: tag, body, draft: false, prerelease: true }),
    });
    if (!made.ok) throw new Error(`GitHub ${made.status} : ${await made.text()}`);
    return made.json();
  }

  async uploadAsset(tag: string, name: string, data: Buffer, contentType: string) {
    const rel = await this.ensureRelease(tag);
    if (rel.assets.some((a) => a.name === name)) return { tag, name };
    const url = rel.upload_url.replace(/\{.*\}$/, "") + `?name=${encodeURIComponent(name)}`;
    const res = await this.gh(url, { method: "POST", body: new Uint8Array(data), headers: { "content-type": contentType } });
    if (!res.ok) throw new Error(`GitHub upload ${res.status} : ${await res.text()}`);
    return { tag, name };
  }

  async downloadAsset(tag: string, name: string): Promise<Buffer | undefined> {
    const got = await this.gh(`/repos/${this.repo}/releases/tags/${encodeURIComponent(tag)}`);
    if (!got.ok) return undefined;
    const rel = await got.json();
    const asset = rel.assets.find((a: any) => a.name === name);
    if (!asset) return undefined;
    const res = await this.gh(asset.url, { headers: { accept: "application/octet-stream" } });
    if (!res.ok) throw new Error(`GitHub download ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
