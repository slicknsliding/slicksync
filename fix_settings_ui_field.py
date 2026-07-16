#!/usr/bin/env python3
"""
Adds a Settings UI field for the AIOMetadata manifest URL, wired to the
existing /api/aiometadata/manifest-url route:

  - client/lib/api.ts: getAiometadataManifestUrl() / updateAiometadataManifestUrl()
  - client/app/(admin)/settings/page.tsx: new "Now Playing Posters" card,
    styled to match the existing Notifications webhook-URL input pattern
    (input + onBlur save + helper text).

Run on WINDOWS, from inside the repo directory.
"""
import sys
from pathlib import Path

REPO = Path.cwd()

def fail(msg):
    print(f"ERROR: {msg}")
    sys.exit(1)

# --- 1. api.ts methods ---
api_path = REPO / "client" / "lib" / "api.ts"
if not api_path.exists():
    fail(f"{api_path} not found")

api_content = api_path.read_text(encoding="utf-8")

if "getAiometadataManifestUrl" in api_content:
    print(f"SKIP: {api_path} already has AIOMetadata methods")
else:
    ANCHOR = "  // --- Vault ---"
    if ANCHOR not in api_content:
        fail(f"could not find Vault section anchor in {api_path}")

    INSERTION = """  // --- AIOMetadata ---

  async getAiometadataManifestUrl() {
    return this.fetch<{ manifestUrl: string | null }>('/aiometadata/manifest-url');
  }

  async updateAiometadataManifestUrl(manifestUrl: string | null) {
    return this.fetch<{ success: boolean; manifestUrl: string | null }>('/aiometadata/manifest-url', {
      method: 'POST',
      body: JSON.stringify({ manifestUrl }),
    });
  }

""" + ANCHOR

    api_content = api_content.replace(ANCHOR, INSERTION, 1)
    api_path.write_text(api_content, encoding="utf-8")
    print(f"OK: added AIOMetadata methods to {api_path}")

# --- 2. Settings page UI ---
page_path = REPO / "client" / "app" / "(admin)" / "settings" / "page.tsx"
if not page_path.exists():
    fail(f"{page_path} not found")

page_content = page_path.read_text(encoding="utf-8")

if "aiometadataManifestUrl" in page_content:
    print(f"SKIP: {page_path} already has the AIOMetadata field")
    sys.exit(0)

# 2a. Add PhotoIcon import
OLD_IMPORT = "  DocumentTextIcon,\n} from '@heroicons/react/24/outline';"
NEW_IMPORT = "  DocumentTextIcon,\n  PhotoIcon,\n} from '@heroicons/react/24/outline';"
if OLD_IMPORT not in page_content:
    fail(f"could not find icon import anchor in {page_path}")
page_content = page_content.replace(OLD_IMPORT, NEW_IMPORT, 1)

# 2b. Add state + load-on-mount
OLD_STATE = "  // Webhook testing\n  const [isTestingWebhook, setIsTestingWebhook] = useState(false);"
NEW_STATE = OLD_STATE + """

  // AIOMetadata manifest URL (used for poster lookups on AIOStreams-proxy-
  // detected Now Playing entries that have no library metadata match)
  const [aiometadataManifestUrl, setAiometadataManifestUrl] = useState('');"""
if OLD_STATE not in page_content:
    fail(f"could not find webhook testing state anchor in {page_path}")
page_content = page_content.replace(OLD_STATE, NEW_STATE, 1)

OLD_LOAD = """      try {
        const keyStatus = await api.getApiKeyStatus();"""
NEW_LOAD = """      try {
        const aiometadataSettings = await api.getAiometadataManifestUrl();
        setAiometadataManifestUrl(aiometadataSettings.manifestUrl || '');
      } catch (e) {
        // Endpoint may not be available
      }

      try {
        const keyStatus = await api.getApiKeyStatus();"""
if OLD_LOAD not in page_content:
    fail(f"could not find API key load anchor in {page_path}")
page_content = page_content.replace(OLD_LOAD, NEW_LOAD, 1)

# 2c. Add save handler, right after handleTestWebhook
OLD_HANDLER = """  const handleGenerateApiKey = async () => {"""
NEW_HANDLER = """  const handleSaveAiometadataManifestUrl = async () => {
    try {
      await api.updateAiometadataManifestUrl(aiometadataManifestUrl.trim() || null);
      toast.success('AIOMetadata manifest URL saved');
    } catch (e: any) {
      toast.error(e.message || 'Failed to save AIOMetadata manifest URL');
    }
  };

  const handleGenerateApiKey = async () => {"""
if OLD_HANDLER not in page_content:
    fail(f"could not find handleGenerateApiKey anchor in {page_path}")
page_content = page_content.replace(OLD_HANDLER, NEW_HANDLER, 1)

# 2d. Add the new card, right after the Notifications PageSection, before API Key
OLD_SECTION = """        {/* API Key */}
        <PageSection delay={0.2} className="mb-6">"""
NEW_SECTION = """        {/* Now Playing Posters */}
        <PageSection delay={0.18} className="mb-6">
          <Card padding="lg">
            <div className="flex items-center gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-secondary-muted">
                <PhotoIcon className="w-5 h-5 text-secondary" />
              </div>
              <div>
                <h3 className="text-base font-semibold font-display text-default">Now Playing Posters</h3>
                <p className="text-xs text-muted">Poster lookups for streams detected via the AIOStreams proxy with no library match</p>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-default mb-2">AIOMetadata Manifest URL</label>
              <input
                type="url"
                value={aiometadataManifestUrl}
                onChange={(e) => setAiometadataManifestUrl(e.target.value)}
                onBlur={handleSaveAiometadataManifestUrl}
                placeholder="https://your-aiometadata-host/stremio/<uuid>/manifest.json"
                className="input-base w-full px-3 py-2 text-sm"
              />
              <p className="text-xs text-muted mt-2">
                Used to fetch posters for Now Playing entries that came from the AIOStreams proxy but have no matching watch session. Leave blank to disable poster lookups.
              </p>
            </div>
          </Card>
        </PageSection>

        {/* API Key */}
        <PageSection delay={0.2} className="mb-6">"""
if OLD_SECTION not in page_content:
    fail(f"could not find API Key section anchor in {page_path}")
page_content = page_content.replace(OLD_SECTION, NEW_SECTION, 1)

page_path.write_text(page_content, encoding="utf-8")
print(f"OK: added Now Playing Posters card to {page_path}")

print()
print("=" * 60)
print("Done. Commit/push/tag/release from Windows as usual:")
print("  git add client/lib/api.ts \"client/app/(admin)/settings/page.tsx\"")
print("  git commit -m 'feat: AIOMetadata manifest URL field in Settings UI'")
print("  git push && git tag v1.9.44 && git push --tags")
print('  gh release create v1.9.44 --title "v1.9.44" --notes "AIOMetadata manifest URL Settings field"')
print()
print("VPS: git pull + rebuild, then set/verify the URL from the actual Settings page in the browser.")
print("=" * 60)
