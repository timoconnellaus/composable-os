// The preview page: `/?block=<name>` mounts that block's preview (previews/<name>.tsx) in the
// frame its skin is drawn in (a web page, or a phone for a native block, through
// react-native-web), and marks the page ready (`body[data-ready]`) once every query it made has
// its answer. With no block named, it lists every preview, for a person looking through them.
import { QueryClient, QueryClientProvider, useIsFetching } from "@tanstack/react-query";
import {
  Component,
  type ComponentType,
  type ReactNode,
  StrictMode,
  useEffect,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import { report } from "./fake.ts";
import "./styles.css";

/** Something to click: an element showing this text, or one with this role and name. */
type Click = string | { readonly role: string; readonly name: string };

/** What a preview file exports: the block as it is drawn, and how wide its picture is. */
interface PreviewModule {
  default: ComponentType;
  /** The picture's width in pixels (a web block's; a native block is a phone's, 390). */
  width?: number;
  /**
   * Text to click before the picture is taken, in order (a native screen's row that opens the
   * part worth showing): the picture script clicks the first element showing each.
   */
  click?: Click | readonly Click[];
  /**
   * Fields to type into after the clicks, in order: each a field's label (or placeholder) and
   * the text to type (a note's template filled in, a name typed to agree).
   */
  fill?: readonly (readonly [label: string, text: string])[];
}

const previews = import.meta.glob<PreviewModule>("../previews/*.tsx");
const nameOf = (path: string) => path.replace(/^.*\//, "").replace(/\.tsx$/, "");
const byName = new Map(Object.entries(previews).map(([path, load]) => [nameOf(path), load]));

/** A native block's frame: a phone's screen, as the mobile app gives a block the whole of it. */
export const PHONE = { width: 390, height: 844 };
const WEB_WIDTH = 1024;

const isNative = (block: string) => block.startsWith("native-") || block.includes("-native-");

class Boundary extends Component<{ children: ReactNode }, { failed: string | null }> {
  override state = { failed: null as string | null };
  static getDerivedStateFromError(error: unknown) {
    return { failed: String(error instanceof Error ? (error.stack ?? error.message) : error) };
  }
  override componentDidCatch(error: unknown) {
    report(`The block threw: ${String(error)}`);
  }
  override render() {
    return this.state.failed ? <pre role="alert">{this.state.failed}</pre> : this.props.children;
  }
}

/** Marks the page ready when nothing is fetching for a few frames in a row. */
function Ready() {
  const fetching = useIsFetching();
  useEffect(() => {
    if (fetching) {
      delete document.body.dataset.ready;
      return;
    }
    let frames = 0;
    let id = 0;
    const tick = () => {
      frames += 1;
      if (frames >= 5) document.body.dataset.ready = "1";
      else id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(id);
  }, [fetching]);
  return null;
}

function Preview({ block }: { block: string }) {
  const [loaded, setLoaded] = useState<PreviewModule | null>(null);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            staleTime: Number.POSITIVE_INFINITY,
            refetchOnWindowFocus: false,
          },
          mutations: { retry: false },
        },
      }),
  );
  useEffect(() => {
    const load = byName.get(block);
    if (!load) {
      report(`No preview for ${block} (apps/screens/previews/${block}.tsx)`);
      return;
    }
    load()
      .then((module) => {
        (globalThis as { __screenClick?: readonly Click[] }).__screenClick =
          module.click === undefined
            ? []
            : Array.isArray(module.click)
              ? module.click
              : [module.click as Click];
        (globalThis as { __screenFill?: PreviewModule["fill"] }).__screenFill = module.fill ?? [];
        setLoaded(module);
      })
      .catch((error: unknown) => report(`The preview did not load: ${String(error)}`));
  }, [block]);
  if (!loaded) return null;
  const Block = loaded.default;
  const native = isNative(block);
  const style = native
    ? {
        width: PHONE.width,
        height: PHONE.height,
        display: "flex",
        flexDirection: "column" as const,
        overflow: "hidden",
      }
    : { width: loaded.width ?? WEB_WIDTH, padding: 24, boxSizing: "border-box" as const };
  return (
    <QueryClientProvider client={queryClient}>
      <div id="frame" data-block={block} data-skin={native ? "native" : "web"} style={style}>
        <Boundary>
          <Block />
        </Boundary>
      </div>
      <Ready />
    </QueryClientProvider>
  );
}

function Index() {
  return (
    <main style={{ fontFamily: "system-ui", padding: 24 }}>
      <h1>Block previews</h1>
      <ul>
        {[...byName.keys()].sort().map((name) => (
          <li key={name}>
            <a href={`?block=${name}`}>{name}</a>
          </li>
        ))}
      </ul>
    </main>
  );
}

const block = new URLSearchParams(window.location.search).get("block");
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<StrictMode>{block ? <Preview block={block} /> : <Index />}</StrictMode>);
}
