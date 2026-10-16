// The resource rule (url.ts, resourceAddress) on its own: the query parameters a recording keeps on an image, poster,
// stylesheet or icon address. Built from the source here, since it is not part of the package's API. The gateway
// applies the same tables to the recordings it stores (README, 1.0.4).
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const out = await build({ entryPoints: [fileURLToPath(new URL("../src/url.ts", import.meta.url))], bundle: true, format: "esm", platform: "neutral", write: false, logLevel: "error" });
const { resourceAddress, recordedSrcset, RESOURCE_PARAMS, NEXT_IMAGE_PARAMS, GOOGLE_FONTS_PARAMS } = await import("data:text/javascript;base64," + Buffer.from(out.outputFiles[0].text).toString("base64"));

const PAGE = "https://shop.example.com/products/tent?variant=1";
const r = (href) => resourceAddress(href, PAGE);

test("the tables are exactly the published ones", () => {
  assert.deepEqual(Object.keys(RESOURCE_PARAMS), ["w", "h", "width", "height", "q", "quality", "dpr", "fit", "format", "fm", "auto", "crop", "v", "ver", "version"]);
  assert.deepEqual(Object.keys(NEXT_IMAGE_PARAMS), ["w", "q"]);
  assert.deepEqual(Object.keys(GOOGLE_FONTS_PARAMS), ["family", "display"]);
});

test("Next.js images keep a site-relative or remote https source, its width and quality; other sources are dropped", () => {
  assert.equal(r("/_next/image?url=%2Fimages%2Fhero.jpg&w=640&q=75"), "https://shop.example.com/_next/image?url=%2Fimages%2Fhero.jpg&w=640&q=75");
  assert.equal(r("/_next/image?url=%2Fuploads%2Fabcdef1234567890ABCDEF12%2Fa.jpg%3Fv%3D3%26sig%3DSECRET&w=64&q=75&dpl=dpl_abc"),
    "https://shop.example.com/_next/image?url=%2Fuploads%2F%3Atoken%2Fa.jpg%3Fv%3D3&w=64&q=75", "the source follows the same rule: tokens, its own query");
  assert.equal(r("/_next/image?url=https%3A%2F%2Fs3.amazonaws.com%2Fb%2Fa.jpg%3FX-Amz-Signature%3Dabc&w=640"), "https://shop.example.com/_next/image?url=https%3A%2F%2Fs3.amazonaws.com%2Fb%2Fa.jpg&w=640", "a remote https source is kept as a file is");
  assert.equal(r("/_next/image?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp.jpg%3Fv%3D1%26width%3D640%26token%3Dx&w=640"), "https://shop.example.com/_next/image?url=https%3A%2F%2Fcdn.shopify.com%2Fs%2Ffiles%2F1%2Fp.jpg%3Fv%3D1%26width%3D640&w=640");
  assert.equal(r("/_next/image?url=http%3A%2F%2Fcdn.example.com%2Fa.jpg&w=640"), "https://shop.example.com/_next/image?w=640", "only https");
  assert.equal(r("/_next/image?url=%2F%2Fevil.example%2Fa.jpg&w=640"), "https://shop.example.com/_next/image?w=640");
  assert.equal(r("/_next/image?url=%2F%5Cevil.example%2Fa.jpg&w=640"), "https://shop.example.com/_next/image?w=640");
  assert.equal(r("https://other.example/_next/image?url=%2Fa.jpg&w=640"), "https://other.example/_next/image?w=640", "only the page's own optimizer keeps url");
});

test("Google Fonts keep family and display, never text", () => {
  assert.equal(r("https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500&display=swap"),
    "https://fonts.googleapis.com/css2?family=Inter%3Awght%40200%3B300%3B400%3B500&display=swap");
  assert.equal(r("https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;1,700&family=Lora&text=Jane%20Doe&display=swap"),
    "https://fonts.googleapis.com/css2?family=Open%20Sans%3Aital%2Cwght%400%2C400%3B1%2C700&family=Lora&display=swap");
  assert.equal(r("https://fonts.googleapis.com/css2?family=Inter&width=400"), "https://fonts.googleapis.com/css2?family=Inter", "the general table does not apply there");
});

test("image CDNs keep size and version parameters with the expected shape", () => {
  assert.equal(r("//shop.example.com/cdn/shop/files/tent.jpg?v=1697041234&width=533"), "https://shop.example.com/cdn/shop/files/tent.jpg?v=1697041234&width=533");
  assert.equal(r("https://cdn.example.com/a.jpg?w=400&h=300&fit=crop&auto=format,compress&q=75&dpr=1.5&fm=webp"),
    "https://cdn.example.com/a.jpg?w=400&h=300&fit=crop&auto=format%2Ccompress&q=75&dpr=1.5&fm=webp");
  assert.equal(r("https://cdn.example.com/a.jpg?width=100000&q=7.5.1&v=a/b&crop=jane@example.com"), "https://cdn.example.com/a.jpg", "values with the wrong shape are dropped");
  assert.equal(r("https://cdn.example.com/a.jpg?constructor=1&__proto__=1&toString=x"), "https://cdn.example.com/a.jpg");
});

test("a version is kept up to 19 characters, so a token-shaped value (20 or more letters and digits) never is", () => {
  assert.equal(r("https://cdn.example.com/a.css?v=abcdefghij012345678"), "https://cdn.example.com/a.css?v=abcdefghij012345678");
  assert.equal(r("https://cdn.example.com/a.css?v=abcdefghij0123456789"), "https://cdn.example.com/a.css");
  assert.equal(r("https://cdn.example.com/a.css?ver=6.4.2&version=Z2NwLWV1cm9wZS13ZXN0NDpxYz12Y2E"), "https://cdn.example.com/a.css?ver=6.4.2");
});

test("fit, format, fm, auto and crop are kept up to 19 characters, for the same reason", () => {
  assert.equal(r("https://cdn.example.com/a.jpg?auto=format,compress"), "https://cdn.example.com/a.jpg?auto=format%2Ccompress");
  assert.equal(r("https://cdn.example.com/a.jpg?fit=abcdefghij012345678"), "https://cdn.example.com/a.jpg?fit=abcdefghij012345678");
  for (const k of ["fit", "format", "fm", "auto", "crop"]) assert.equal(r(`https://cdn.example.com/a.jpg?${k}=abcdefghij0123456789`), "https://cdn.example.com/a.jpg", k);
});

test("signed addresses, map queries and tokens in paths lose what they carry", () => {
  assert.equal(r("https://bucket.s3.amazonaws.com/u/1/photo.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20261016&X-Amz-Expires=3600&X-Amz-Signature=0123456789abcdef&width=200"),
    "https://bucket.s3.amazonaws.com/u/1/photo.jpg?width=200");
  assert.equal(r("https://storage.googleapis.com/b/a.pdf?GoogleAccessId=x&Expires=1&Signature=abc%3D"), "https://storage.googleapis.com/b/a.pdf");
  assert.equal(r("https://maps.googleapis.com/maps/api/staticmap?center=12+Main+St,Springfield&zoom=13&size=600x300&markers=12+Main+St&key=AIzaSyEXAMPLE"),
    "https://maps.googleapis.com/maps/api/staticmap");
  assert.equal(r("https://cdn.example.com/files/abcdef1234567890ABCDEF12/invoice.png?v=2"), "https://cdn.example.com/files/:token/invoice.png?v=2");
  assert.equal(r("https://secure.gravatar.com/avatar/0123456789abcdef0123456789abcdef?s=96&d=mm"), "https://secure.gravatar.com/avatar/:token");
});

test("anything that is not a web address, or cannot be read, is empty", () => {
  assert.equal(r("data:image/png;base64,AAAA"), "");
  assert.equal(r("blob:https://shop.example.com/0f0e"), "");
  assert.equal(r("http://[bad"), "");
});

test("a srcset is split in linear time, whatever it holds, and keeps at most 64 candidates", () => {
  globalThis.location = { href: PAGE }; // recordedSrcset resolves addresses against the page it runs on
  const t = performance.now();
  const out = recordedSrcset("a" + ",".repeat(200000) + "b,");
  assert.ok(performance.now() - t < 500, `200,000 commas: ${Math.round(performance.now() - t)} ms`);
  assert.ok(out.startsWith("https://shop.example.com/products/a"));
  const many = Array.from({ length: 100 }, (_, i) => `/img/${i}.jpg ${i + 1}w`).join(", ");
  const kept = recordedSrcset(many).split(", ");
  assert.equal(kept.length, 64);
  assert.equal(kept[63], "https://shop.example.com/img/63.jpg 64w");
});
