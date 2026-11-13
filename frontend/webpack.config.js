// Bundles the frontend into dist/ (what the backend serves as FRONTEND_DIR, next to /vendor):
//
//   npm ci && npm run build        production build
//   npm run watch                  development build, rebuilds on every change
//
// Every page (*.html, viewers/*.html) is a template: its script is pages/<name>.js (an entry), the stylesheet and
// the tiny theme-init script are put into the page by the template (see the <%= require(...) %> there). All files
// get a hash of their content in their name (js/volume.3fa9c0d1b2e4.js), so a browser never has a stale copy of a
// file whose content changed, and never has to download one that did not: no ?v=... on any URL.
// What is not hashed and why: the HTML pages (they carry the hashes: the server sends them with
// Cache-Control: no-cache), css/style.css and favicon.ico (kept under their plain names), js/sw.js (the service
// worker has to keep its URL), /vendor/* (the prebuilt Potree and 3DHOP libraries the viewer pages load as classic
// scripts; the Docker build adds them to the served directory).

const fs = require("fs");
const path = require("path");
const HtmlWebpackPlugin = require("html-webpack-plugin");
const { Compilation, sources } = require("webpack");

// kiln-render, the volume renderer (a prebuilt module that the Docker build makes in its `kiln` stage and
// copies here); bundled into the volume page, which imports it as "kiln-render".
const KILN_RENDER = process.env.KILN_RENDER_LIB || path.resolve(__dirname, "vendor/kiln-render/lib/kiln-render.js");

// Files that go to dist/ as they are, under their plain names, because something asks for them by that name:
// the browser asks for /favicon.ico on its own (no page links it).
const STATIC_FILES = ["favicon.ico"];

class PlainNames {
  apply(compiler) {
    compiler.hooks.thisCompilation.tap("PlainNames", (compilation) => {
      compilation.hooks.processAssets.tap({ name: "PlainNames", stage: Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL }, (assets) => {
        // The server writes one small page itself (backend/app/routers/shares.py: "link unavailable"), which links
        // the stylesheet by its plain name: a copy of the hashed file goes to css/style.css for it.
        const hashed = Object.keys(assets).find((n) => /^css\/style\.[0-9a-f]{12}\.css$/.test(n));
        if (hashed) compilation.emitAsset("css/style.css", new sources.RawSource(assets[hashed].source()));
        for (const file of STATIC_FILES) {
          const from = path.join(__dirname, file);
          compilation.fileDependencies.add(from); // (watch mode rebuilds when it changes)
          compilation.emitAsset(file, new sources.RawSource(fs.readFileSync(from)));
        }
      });
    });
  }
}

const pages = [
  ...fs.readdirSync(__dirname).filter((f) => f.endsWith(".html")),
  ...fs.readdirSync(path.join(__dirname, "viewers")).filter((f) => f.endsWith(".html")).map((f) => `viewers/${f}`),
].map((file) => ({ file, name: path.basename(file, ".html") }));

module.exports = (env, argv) => {
  if (!fs.existsSync(KILN_RENDER)) {
    throw new Error(
      `kiln-render was not found at ${KILN_RENDER}. The Docker build puts it there (it builds the patched library in its ` +
        "`kiln` stage); for a build outside Docker point KILN_RENDER_LIB at a built kiln-render.js."
    );
  }
  return {
    context: __dirname,
    target: ["web", "es2020"],
    entry: {
      ...Object.fromEntries(pages.map(({ name }) => [name, `./pages/${name}.js`])),
      sw: "./js/sw.js",
    },
    output: {
      path: path.resolve(__dirname, "dist"),
      publicPath: "/",
      // the service worker is registered as /js/sw.js: its URL cannot change
      filename: (data) => (data.chunk.name === "sw" ? "js/sw.js" : "js/[name].[contenthash:12].js"),
      chunkFilename: "js/[name].[contenthash:12].js",
      assetModuleFilename: "assets/[name].[contenthash:12][ext]",
      clean: true,
    },
    resolve: { alias: { "kiln-render": KILN_RENDER } },
    module: {
      rules: [
        { test: /\.css$/, type: "asset/resource", generator: { filename: "css/[name].[contenthash:12][ext]" } },
        { resourceQuery: /raw/, type: "asset/source" }, // js/theme-init.js, put into the page as it is
      ],
    },
    optimization: {
      splitChunks: {
        // what several pages use (api.js, help.js ...) is one file they share; the service worker and the slice
        // workers (scripts of their own) stay whole
        chunks: (chunk) => chunk.name !== "sw" && chunk.name !== "slice-worker",
      },
    },
    plugins: [new PlainNames()].concat(pages.map(
      ({ file, name }) =>
        new HtmlWebpackPlugin({
          template: file,
          filename: file,
          chunks: [name],
          inject: "head",
          scriptLoading: "defer", // runs after the page is parsed, like the type="module" script it replaces
          minify: false, // the pages stay as written
        })
    )),
    devtool: "source-map",
    performance: { hints: false },
    stats: "minimal",
  };
};
