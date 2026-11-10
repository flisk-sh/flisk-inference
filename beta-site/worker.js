// API paths answer with a clear 503; everything else is the static beta page.
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/v1/") || pathname.startsWith("/api/") || pathname.startsWith("/auth/")) {
      return Response.json(
        { error: { message: "Flisk Inference is in private beta; the hosted API is not public yet. Run the model yourself: https://inference.flisk.si/#run-it", type: "unavailable" } },
        { status: 503, headers: { "retry-after": "86400" } },
      );
    }
    return env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  },
};
