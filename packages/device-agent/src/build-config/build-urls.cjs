// The deployment URLs baked into the device agent at build time. There is no default:
// upstream defaulted to its own portal and API, so an agent built without them would
// enroll devices with, report compliance to and fetch updates from upstream Comp.
// A missing or malformed value fails the build, naming the variable, never echoing it.

const BUILD_URL_NAMES = ['PORTAL_URL', 'API_URL', 'AUTO_UPDATE_URL'];

/** One required http(s) URL from `env`, trimmed and without a trailing slash. */
function requiredBuildUrl({ name, env }) {
  const value = env[name]?.trim().replace(/\/+$/, '');
  if (!value) {
    throw new Error(
      `${name} must be set to build the device agent (for example https://portal.example.com); there is no default.`,
    );
  }
  let protocol;
  try {
    protocol = new URL(value).protocol;
  } catch {
    protocol = undefined;
  }
  if (protocol !== 'https:' && protocol !== 'http:') {
    throw new Error(`${name} must be an absolute http(s) URL to build the device agent.`);
  }
  return value;
}

/** Every URL the device agent is built with. */
function requiredBuildUrls(env) {
  return Object.fromEntries(BUILD_URL_NAMES.map((name) => [name, requiredBuildUrl({ name, env })]));
}

/** `electron-vite dev` (turbo dev) talks to the local stack unless told otherwise. */
const LOCAL_DEV_URLS = {
  PORTAL_URL: 'http://localhost:3002',
  API_URL: 'http://localhost:3333',
  AUTO_UPDATE_URL: 'http://localhost:3002/api/device-agent/updates',
};

/** The URLs for an electron-vite command: required for `build`, local defaults for `serve`. */
function deviceAgentUrls({ command, env }) {
  if (command === 'build') return requiredBuildUrls(env);
  return Object.fromEntries(
    BUILD_URL_NAMES.map((name) => [
      name,
      env[name]?.trim() ? requiredBuildUrl({ name, env }) : LOCAL_DEV_URLS[name],
    ]),
  );
}

module.exports = { BUILD_URL_NAMES, deviceAgentUrls, requiredBuildUrl, requiredBuildUrls };
