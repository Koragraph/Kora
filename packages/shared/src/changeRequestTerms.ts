export interface ChangeRequestPresentation {
  readonly icon: "github" | "gitlab" | "forgejo" | "azure-devops" | "bitbucket" | "change-request";
  readonly urlExample: string;
  readonly checkoutCommandExample?: string;
  readonly providerLongName: string;
  readonly pluralLongName: string;
  readonly longName: string;
  readonly shortName: string;
  readonly providerName: string;
}

export interface ChangeRequestTerminology {
  readonly singular: string;
  readonly shortLabel: string;
}

const AZURE_CANONICAL = "dev.azure.com/$1/$2/_git/$3";
const AZURE_SSH_KEY =
  /^(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com)\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/u;
const AZURE_LEGACY_KEY =
  /^([^.]+)\.visualstudio\.com\/(?:defaultcollection\/)?([^/]+)\/_git\/([^/]+)$/u;

export function canonicalRepositoryKey(key: string): string {
  return [AZURE_SSH_KEY, AZURE_LEGACY_KEY].reduce(
    (current, pattern) => current.replace(pattern, AZURE_CANONICAL),
    key,
  );
}
