# Bake definition for the Comp images (deploy/aws/Dockerfile). Run from the repository root:
#
#   TAG=$(git rev-parse --short=12 HEAD) REGISTRY=<account>.dkr.ecr.<region>.amazonaws.com \
#     docker buildx bake -f deploy/aws/docker-bake.hcl --push
#
# With REGISTRY empty (local builds) images are tagged comp-<name>:<TAG> and use only the
# builder's local cache. With REGISTRY set they are tagged <REGISTRY>/comp-<name>:<TAG> and
# read and write a mode=max registry cache at <REGISTRY>/comp-<name>:cache.
# The NEXT_PUBLIC_* args must match public-env.ts (checked by tests/images.smoke.sh).

variable "TAG" {
  default = "dev"
}

variable "REGISTRY" {
  default = ""
}

variable "APP_URL" {
  default = "https://app.comp.revola.ai"
}

variable "API_URL" {
  default = "https://api.comp.revola.ai"
}

variable "PORTAL_URL" {
  default = "https://portal.comp.revola.ai"
}

function "image" {
  params = [name]
  result = REGISTRY == "" ? "comp-${name}:${TAG}" : "${REGISTRY}/comp-${name}:${TAG}"
}

function "cache_from" {
  params = [name]
  result = REGISTRY == "" ? [] : ["type=registry,ref=${REGISTRY}/comp-${name}:cache"]
}

function "cache_to" {
  params = [name]
  result = REGISTRY == "" ? [] : [
    "type=registry,ref=${REGISTRY}/comp-${name}:cache,mode=max,image-manifest=true,oci-mediatypes=true"
  ]
}

group "default" {
  targets = ["api", "app", "portal"]
}

target "_common" {
  context    = "."
  dockerfile = "deploy/aws/Dockerfile"
  platforms  = ["linux/arm64"]
  attest     = ["type=provenance,disabled=true", "type=sbom,disabled=true"]
}

target "api" {
  inherits   = ["_common"]
  target     = "api"
  tags       = [image("api")]
  cache-from = cache_from("api")
  cache-to   = cache_to("api")
}

target "app" {
  inherits = ["_common"]
  target   = "app"
  tags     = [image("app")]
  args = {
    NEXT_PUBLIC_API_URL         = API_URL
    NEXT_PUBLIC_APP_URL         = APP_URL
    NEXT_PUBLIC_PORTAL_URL      = PORTAL_URL
    NEXT_PUBLIC_BETTER_AUTH_URL = APP_URL
    NEXT_PUBLIC_SELF_HOSTED     = "true"
    NEXT_PUBLIC_APP_ENV         = "production"
  }
  cache-from = cache_from("app")
  cache-to   = cache_to("app")
}

target "portal" {
  inherits = ["_common"]
  target   = "portal"
  tags     = [image("portal")]
  args = {
    NEXT_PUBLIC_API_URL         = API_URL
    NEXT_PUBLIC_APP_URL         = APP_URL
    NEXT_PUBLIC_PORTAL_URL      = PORTAL_URL
    NEXT_PUBLIC_BETTER_AUTH_URL = PORTAL_URL
  }
  cache-from = cache_from("portal")
  cache-to   = cache_to("portal")
}
