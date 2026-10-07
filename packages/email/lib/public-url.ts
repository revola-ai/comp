const warnedVariables = new Set<string>();

/**
 * This deployment's public base URL for links in emails and notifications: the first of
 * `variables` that is set, trimmed and without a trailing slash.
 *
 * There is deliberately no built-in default. Upstream Comp defaulted to its own hosts
 * (app/portal/api.trycomp.ai), so a laptop without the variable sent every recipient,
 * with their address, record ids and signed unsubscribe token, to upstream's servers.
 * Unset returns undefined and the caller leaves the link or header out; one warning per
 * variable list per process names the variables, never a value.
 */
export function publicBaseUrl(variables: readonly string[]): string | undefined {
  for (const name of variables) {
    const value = process.env[name]?.trim().replace(/\/+$/, '');
    if (value) return value;
  }
  const names = variables.join(' / ');
  if (!warnedVariables.has(names)) {
    warnedVariables.add(names);
    console.warn(
      `[email] ${names} is not set: links and headers that need it are left out of emails and notifications. Set it to the public URL of this deployment.`,
    );
  }
  return undefined;
}
