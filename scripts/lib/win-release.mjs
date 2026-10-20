// win-release.mjs — the pure half of the Windows release build (scripts/package-win.mjs): where the update feed points
// and how the installer is signed, decided from flags and the environment. Tested in win-release.test.ts.
//
// Signing (Authenticode) is optional and chosen by which secrets are present; with none the build is unsigned, as before:
//   Azure Trusted Signing   KORA_WIN_AZURE_ENDPOINT, KORA_WIN_AZURE_ACCOUNT, KORA_WIN_AZURE_PROFILE, KORA_WIN_PUBLISHER
//                           + AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET (read by electron-builder's signer)
//   a .pfx certificate      WIN_CSC_LINK (base64 or path of the .pfx) + WIN_CSC_KEY_PASSWORD (electron-builder reads
//                           both itself), optional KORA_WIN_PUBLISHER (the certificate's CN)
// Half a set is an error, never a silent unsigned build.

const AZURE = [
  "KORA_WIN_AZURE_ENDPOINT",
  "KORA_WIN_AZURE_ACCOUNT",
  "KORA_WIN_AZURE_PROFILE",
  "KORA_WIN_PUBLISHER",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
];

const set = (env, name) => typeof env[name] === "string" && env[name].trim() !== "";

/**
 * `--update-feed` → electron-builder's publish entry (it writes resources\app-update.yml and latest.yml from it).
 * Same rules as package-app.sh: github:<owner>/<repo>, or generic:https://… (plain http only on loopback).
 */
export function updatePublishConfig(feed) {
  if (!feed) return null;
  const gh = /^github:([\w.-]+)\/([\w.-]+)$/.exec(feed);
  if (gh) return { provider: "github", owner: gh[1], repo: gh[2], releaseType: "release" };
  const generic =
    /^generic:(https:\/\/\S+|http:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/\S*)?)$/.exec(feed);
  if (generic) return { provider: "generic", url: generic[1] };
  throw new Error(
    "--update-feed takes github:<owner>/<repo> or generic:<https url> (http only on 127.0.0.1/localhost)",
  );
}

/**
 * How to sign, from the environment. `win` is merged into electron-builder's `win` config; `force` turns on
 * forceCodeSigning so a signer that fails stops the build instead of shipping unsigned.
 */
export function winSigning(env) {
  if (set(env, "KORA_WIN_AZURE_ENDPOINT")) {
    const missing = AZURE.filter((n) => !set(env, n));
    if (missing.length)
      throw new Error(`Azure Trusted Signing is half set up; missing: ${missing.join(", ")}`);
    return {
      mode: "azure",
      force: true,
      win: {
        azureSignOptions: {
          endpoint: env.KORA_WIN_AZURE_ENDPOINT.trim(),
          codeSigningAccountName: env.KORA_WIN_AZURE_ACCOUNT.trim(),
          certificateProfileName: env.KORA_WIN_AZURE_PROFILE.trim(),
          publisherName: env.KORA_WIN_PUBLISHER.trim(),
        },
      },
    };
  }
  if (set(env, "WIN_CSC_LINK") || set(env, "CSC_LINK")) {
    if (!set(env, "WIN_CSC_KEY_PASSWORD") && !set(env, "CSC_KEY_PASSWORD"))
      throw new Error("WIN_CSC_LINK is set but WIN_CSC_KEY_PASSWORD is not");
    return {
      mode: "pfx",
      force: true,
      win: set(env, "KORA_WIN_PUBLISHER")
        ? { signtoolOptions: { publisherName: env.KORA_WIN_PUBLISHER.trim() } }
        : {},
    };
  }
  return { mode: "none", force: false, win: {} };
}

/**
 * Why this build may not carry an update feed, or null (2026-10-15 audit desktop #7). electron-updater checks a Windows
 * update against the publisher name of the running app; unsigned, or signed with no publisherName, it checks only the
 * sha512 from the same feed, so whoever controls the release repo would get code on every install. A feed therefore
 * needs a signed build with KORA_WIN_PUBLISHER set.
 */
export function updateFeedRefusal(publish, signing) {
  if (!publish) return null;
  if (signing.mode === "none")
    return "--update-feed needs a signed build (Azure Trusted Signing or WIN_CSC_LINK): an unsigned app would accept any update";
  const publisher =
    signing.win?.azureSignOptions?.publisherName ?? signing.win?.signtoolOptions?.publisherName;
  if (!publisher)
    return "--update-feed needs KORA_WIN_PUBLISHER (the certificate's CN): without it updates are not checked against the publisher";
  return null;
}

/**
 * The update-feed files electron-builder left in its output folder: latest.yml (or <channel>.yml for a prerelease
 * version), never its own builder-debug.yml.
 */
export function updateFeedFiles(names) {
  return names.filter((n) => n.endsWith(".yml") && n !== "builder-debug.yml").sort();
}
