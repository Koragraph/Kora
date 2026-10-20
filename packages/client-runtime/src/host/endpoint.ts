export const hostEndpointUrl = (httpBaseUrl: string, pathname: string): string => {
  return Object.assign(new URL(httpBaseUrl), { pathname, search: "", hash: "" }).toString();
};
