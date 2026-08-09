export const modelAliasPattern = /^[A-Za-z0-9._:/-]+$/;

export function isValidModelAlias(value: string): boolean {
  return modelAliasPattern.test(value);
}
