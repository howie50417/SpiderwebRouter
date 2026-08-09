export function optionalGrantAlias(value: string | null | undefined): string | undefined {
  const alias = value?.trim();
  return alias ? alias : undefined;
}

export function ungrantedModelIds(
  modelIds: readonly string[],
  grantedModelIds: readonly string[],
): string[] {
  const granted = new Set(grantedModelIds);
  return [...new Set(modelIds)].filter((id) => !granted.has(id));
}
