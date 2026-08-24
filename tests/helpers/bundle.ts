/**
 * Bundles one api-server service for a unit test, with its database handle,
 * artifact storage client and logger stubbed out.
 *
 * The api-server sources use extensionless relative imports, which the build
 * resolves and bare node does not, so a test cannot import them directly. The
 * stubs keep these tests pure: no connection string, no bucket, and no pino
 * transport pulling in dynamic requires the ESM bundle cannot satisfy.
 */
import { build } from "../../artifacts/api-server/node_modules/esbuild/lib/main.js";

const STUBS: Record<string, string> = {
  db: "export const pool = { query() { throw new Error('no database in this test'); }, "
    + "connect() { throw new Error('no database in this test'); } };\nexport const db = {};\n",
  logger: "export const logger = { error() {}, warn() {}, info() {}, debug() {} };\nexport default logger;\n",
  storage: "export async function verifyModelArtifact() { throw new Error('no storage in this test'); }\n"
    + "export async function storeModelArtifact() { throw new Error('no storage in this test'); }\n",
};

const cache = new Map<string, Promise<Record<string, unknown>>>();

export function bundleService(entry: string): Promise<Record<string, unknown>> {
  const cached = cache.get(entry);
  if (cached) return cached;
  const loading = (async () => {
    const result = await build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [{
        name: "service-stubs",
        setup(pluginBuild: { onResolve: Function; onLoad: Function }) {
          pluginBuild.onResolve(
            { filter: /(^@workspace\/db$|lib\/logger$|model-artifact-storage$)/ },
            (args: { path: string }) => ({
              path: args.path === "@workspace/db"
                ? "db"
                : args.path.endsWith("logger") ? "logger" : "storage",
              namespace: "service-stub",
            }),
          );
          pluginBuild.onLoad(
            { filter: /.*/, namespace: "service-stub" },
            (args: { path: string }) => ({ contents: STUBS[args.path], loader: "js" }),
          );
        },
      }],
    });
    const source = Buffer.from(result.outputFiles[0].contents).toString("utf8");
    return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  })();
  cache.set(entry, loading);
  return loading;
}
