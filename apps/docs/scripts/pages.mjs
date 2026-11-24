// The site's pages, built from the code's facts (extract.mjs) and the files beside it
// (sources.mjs). Each page says whether it needs the code (`code: true`): the documents lane,
// which has no install, rebuilds only the pages that need nothing but files.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rewriteLinks } from "./lib/links.mjs";
import { schemaTable } from "./lib/schema.mjs";
import { cell, code, firstSentence, inline, page, slug, table } from "./lib/text.mjs";
import { OVERVIEW_SECTIONS } from "./sources.mjs";

/** The sub-pages every pack has, in sidebar order. */
export const PACK_PAGES = [
  ["data-model", "Data model"],
  ["tools", "Operations and tools"],
  ["permissions", "Permissions and roles"],
  ["screens", "Screens"],
  ["messages", "Messages"],
  ["settings", "Settings"],
  ["decisions", "Decisions"],
];

/** The sub-pages every capability has. */
export const CAPABILITY_PAGES = [
  ["operations", "Operations"],
  ["permissions", "Permissions"],
  ["behaviours", "Behaviours"],
  ["screens", "Screens"],
  ["decisions", "Decisions"],
];

export const urlOf = (path) =>
  `/${path.replace(/(^|\/)index\.md$/, "$1").replace(/\.md$/, "/")}`.replace(/\/+$/, "/");

const opGroup = (name) => name.split(".")[0];
/** A group's page: Astro lowercases a page's slug. */
const groupPath = (g) => g.toLowerCase();
export const opLink = (name) => `/reference/operations/${groupPath(opGroup(name))}/#${slug(name)}`;
const toolLink = (pack, tool) => `/packs/${pack}/tools/#${slug(tool)}`;
const blockLink = (name) => `/reference/blocks/${name}/`;
const behaviourLink = (key) => `/reference/behaviours/#${slug(key)}`;

/** A link for an operation name as a block or a pack lists it: a core operation or a pack tool. */
function operationRef(name, ctx) {
  const tool = name.match(/^x\.([a-z0-9]+)\.(.+)$/);
  if (tool) {
    return ctx.packIds.includes(tool[1])
      ? `[${code(name)}](${toolLink(tool[1], tool[2])})`
      : code(name);
  }
  return ctx.opNames?.has(name) ? `[${code(name)}](${opLink(name)})` : code(name);
}

const list = (v) => (Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]);
const codes = (v) => list(v).map(code).join(", ");

function repoUrl(ctx, path) {
  return `${ctx.repository}/blob/main/${path}`;
}

function specLine(o, ctx) {
  if (!o.spec) return "";
  const stage = o.stage ? `stage ${o.stage}` : "its stage";
  return `The specification is ${stage}'s, [${o.spec.split("/").pop()}](${repoUrl(ctx, o.spec)}).`;
}

// ---------------------------------------------------------------------------------------------
// Overviews and decisions (files only)

function checkOverview(o, problems) {
  let at = -1;
  for (const section of OVERVIEW_SECTIONS) {
    const i = o.body.search(new RegExp(`^## ${section}\\s*$`, "m"));
    if (i < 0) problems.push(`${o.path}: needs a "## ${section}" section`);
    else if (i < at) problems.push(`${o.path}: "## ${section}" is out of order`);
    else at = i;
  }
  for (const key of ["title", "summary"]) {
    if (!o[key]) problems.push(`${o.path}: front matter needs ${key}`);
  }
}

function overviewPage(o, base, subpages, ctx) {
  checkOverview(o, ctx.problems);
  const body = rewriteLinks(o.body, o.path, ctx);
  const refs = subpages.map(([p, label]) => `- [${label}](/${base}/${p}/)`).join("\n");
  const spec = specLine(o, ctx);
  return {
    path: `${base}/index.md`,
    code: false,
    content: page(
      { title: o.title, description: o.summary, order: 0, label: "Overview" },
      `${inline(o.summary)}\n\n${body}\n\n## Reference\n\nGenerated from the code:\n\n${refs}${
        spec ? `\n\n${spec}` : ""
      }\n\nThis page is [${o.path.split("/").slice(-3).join("/")}](${repoUrl(ctx, o.path)}), written by hand beside the code.`,
    ),
  };
}

function decisionsPage(o, base, ctx) {
  const rows = o.adrs.map((n) => {
    const adr = ctx.adrs[String(n).padStart(4, "0")];
    if (!adr) {
      ctx.problems.push(`${o.path}: ADR ${n} does not exist`);
      return [code(n), ""];
    }
    return [`[ADR ${adr.number}](${repoUrl(ctx, adr.path)})`, cell(adr.title)];
  });
  const spec = specLine(o, ctx);
  return {
    path: `${base}/decisions.md`,
    code: false,
    content: page(
      { title: `${o.title}: decisions`, label: "Decisions", order: 90 },
      `The decisions this ${o.kind} rests on, as recorded in the repository's ADRs.\n\n${table(
        ["ADR", "Decision"],
        rows,
        "No ADRs are listed in the overview's front matter.",
      )}${spec ? `\n\n${spec}` : ""}`,
    ),
  };
}

// ---------------------------------------------------------------------------------------------
// Packs (code)

function fieldDetails(f) {
  const out = [];
  if (f.type === "relation" && f.to) out.push(`to ${code(f.to)}${f.many ? ", many" : ""}`);
  if (f.options) {
    const values = f.options.map((o) => code(typeof o === "string" ? o : o.value));
    out.push(`one of ${values.slice(0, 14).join(", ")}${values.length > 14 ? ", …" : ""}`);
  }
  if (f.formula)
    out.push(
      `formula ${code(typeof f.formula === "string" ? f.formula : JSON.stringify(f.formula))}`,
    );
  if (f.default !== undefined) out.push(`default ${code(JSON.stringify(f.default))}`);
  if (f.min !== undefined) out.push(`min ${f.min}`);
  if (f.max !== undefined) out.push(`max ${f.max}`);
  if (f.readOnly) out.push("read-only");
  if (f.personApproves) out.push("a person's to change");
  if (f.unique) out.push("unique");
  return out.join("; ");
}

function fieldsTable(fields = {}) {
  return table(
    ["Field", "Type", "Label", "Required", "Details", "Description"],
    Object.entries(fields).map(([name, f]) => [
      code(name),
      code(f.type),
      cell(f.label),
      f.required ? "yes" : "",
      cell(fieldDetails(f)),
      cell(f.description),
    ]),
  );
}

function dataModelPage(id, m, ctx) {
  const behaviourKeys = new Set(ctx.facts.behaviours.map((b) => b.key));
  const parts = [];
  const requires = list(m.requires);
  parts.push(
    requires.length
      ? `Requires ${requires.map((r) => `[${r}](/packs/${r}/)`).join(", ")}: the host refuses to install it while one is missing.`
      : "It requires no other pack.",
  );
  for (const [name, o] of Object.entries(m.objects ?? {})) {
    const declared = Object.keys(o).filter((k) => behaviourKeys.has(k));
    const relations = Object.entries(o.fields ?? {}).filter(([, f]) => f.type === "relation");
    parts.push(`## ${o.label} (${code(`${id}.${name}`)})`);
    if (o.description) parts.push(inline(o.description));
    const facts = [
      ["Plural", cell(o.plural)],
      ["Title field", code(o.titleField)],
      ["Listed in", cell(o.navigation ?? "main")],
    ];
    if (declared.length) {
      facts.push([
        "Behaviours",
        declared.map((k) => `[${code(k)}](${behaviourLink(k)})`).join(", "),
      ]);
    }
    if (o.indexes?.length)
      facts.push(["Indexes", o.indexes.map((i) => code(i.join(", "))).join("; ")]);
    if (o.owner) facts.push(["Owner field", code(o.owner)]);
    parts.push(table(["", ""], facts));
    parts.push(`### Fields\n\n${fieldsTable(o.fields)}`);
    if (relations.length) {
      parts.push(
        `### Relations\n\n${relations
          .map(([f, r]) => `- ${code(f)} → ${code(r.to)}${r.many ? " (many)" : ""}`)
          .join("\n")}`,
      );
    }
    if (declared.length) {
      const json = Object.fromEntries(declared.map((k) => [k, o[k]]));
      parts.push(
        `### Behaviour declarations\n\n<details>\n<summary>The declarations as the manifest gives them</summary>\n\n\`\`\`json\n${JSON.stringify(json, null, 2)}\n\`\`\`\n\n</details>`,
      );
    }
  }
  const added = Object.entries(m.fields ?? {});
  if (added.length) {
    parts.push("## Fields on other objects");
    for (const [target, fields] of added)
      parts.push(`### On ${code(target)}\n\n${fieldsTable(fields)}`);
  }
  const views = Object.entries(m.views ?? {});
  if (views.length) {
    parts.push(
      `## Views\n\n${table(
        ["View", "Object", "Label"],
        views.map(([k, v]) => [code(k), code(v.object ?? ""), cell(v.label)]),
      )}`,
    );
  }
  const tabs = [
    ...Object.entries(m.recordTabs ?? {}).map(([k, v]) => ["tab", k, v]),
    ...Object.entries(m.recordPanels ?? {}).map(([k, v]) => ["panel", k, v]),
  ];
  if (tabs.length) {
    parts.push(
      `## On other records' pages\n\n${table(
        ["Kind", "Key", "On", "Label"],
        tabs.map(([kind, k, v]) => [kind, code(k), code(v.object ?? ""), cell(v.label)]),
      )}`,
    );
  }
  return parts.join("\n\n");
}

function toolFacts(t) {
  const rows = [
    ["Risk", code(t.risk ?? "write")],
    ["Audiences", codes(t.audiences ?? ["staff"])],
  ];
  if (t.permission) rows.push(["Permission", codes(t.permission)]);
  if (t.corePermission) rows.push(["Core permission", code(t.corePermission)]);
  if (t.humanOnly) rows.push(["Who may call it", "a person only (`humanOnly`)"]);
  if (t.personApproves)
    rows.push(["Approval", "a person approves anyone else's call (`personApproves`)"]);
  if (t.anyStaff) rows.push(["Staff", "every staff account (`anyStaff`)"]);
  if (t.recordAction) rows.push(["Button on", code(t.recordAction.object ?? "")]);
  if (t.redact?.length) rows.push(["Kept from the audit log", codes(t.redact)]);
  return table(["", ""], rows);
}

function toolsPage(id, m, ctx) {
  const parts = [];
  const tools = Object.entries(m.tools ?? {});
  parts.push(
    `Each tool is called as ${code(`x.${id}.<tool>`)}. Its description is the one a model reads. Input and output are the tool's schemas.`,
  );
  parts.push("## Tools");
  if (!tools.length) parts.push("None.");
  for (const [name, t] of tools) {
    parts.push(`### ${name}`);
    parts.push(inline(t.description));
    parts.push(toolFacts(t));
    parts.push(`#### Input\n\n${schemaTable(t.input)}`);
    parts.push(`#### Output\n\n${schemaTable(t.output)}`);
  }
  const autos = Object.entries(m.automations ?? {});
  parts.push("## Automations");
  if (!autos.length) parts.push("None.");
  for (const [name, a] of autos) {
    const trig = a.trigger ?? {};
    const steps = (a.steps ?? []).map((s) => `${code(s.name)} ${cell(s.label ?? "")}`).join("; ");
    const conns = (a.connections ?? []).map((c) => code(c.gatekeeper)).join(", ");
    parts.push(`### ${name}`);
    parts.push(`**${inline(a.label ?? name)}.** ${inline(a.description ?? "")}`);
    const rows = [
      [
        "Trigger",
        cell(
          `${trig.type ?? ""}${trig.object ? ` on ${trig.object}` : ""}${trig.on ? ` (${list(trig.on).join(", ")})` : ""}${trig.field ? `, field ${trig.field}` : ""}${trig.cron ? `, ${trig.cron}` : ""}`,
        ),
      ],
    ];
    if (steps) rows.push(["Steps", steps]);
    if (conns) rows.push(["Gatekeepers", conns]);
    parts.push(table(["", ""], rows));
  }
  const boards = Object.entries(m.dashboards ?? {});
  if (boards.length) {
    parts.push(
      `## Dashboards\n\n${table(
        ["Dashboard", "Label", "Widgets"],
        boards.map(([k, d]) => [
          code(k),
          cell(d.label),
          String(Object.keys(d.widgets ?? {}).length || list(d.widgets).length),
        ]),
      )}`,
    );
  }
  const ops = list(m.permissions?.operations);
  parts.push(
    `## Core operations it may call\n\nThe operations its code may call through ${code("ctx.ops")}, as its manifest asks for them.\n\n${
      ops.length ? ops.map((o) => `- ${operationRef(o, ctx)}`).join("\n") : "None."
    }`,
  );
  const modules = list(m.permissions?.modules);
  if (modules.length) parts.push(`Host modules it asks for: ${codes(modules)}.`);
  return parts.join("\n\n");
}

function permissionsPage(id, m) {
  const tools = Object.entries(m.tools ?? {});
  const perms = new Map();
  for (const [name, t] of tools) {
    for (const p of list(t.permission)) {
      if (!perms.has(p)) perms.set(p, []);
      perms.get(p).push(name);
    }
  }
  for (const p of [...list(m.restricted), ...list(m.grantable)])
    if (!perms.has(p)) perms.set(p, []);
  const roles = Object.entries(m.roles ?? {});
  const restricted = new Set(list(m.restricted));
  const grantable = new Set(list(m.grantable));
  const labels = m.grantableLabels ?? {};
  const parts = [
    "A tool with no permission of its own is held by admins and members as any tool is (a viewer only when its risk is `read`). A permission a tool names is held by the roles that list it; a **restricted** one is held by admins and by a staff account an admin granted it, and by nobody else; a **grantable** one can be granted to a staff account one by one.",
    `## Permissions its tools declare\n\n${table(
      ["Permission", "Tools", "Restricted", "Grantable", "Roles holding it", "What a grant gives"],
      [...perms].map(([p, ts]) => [
        code(p),
        ts.map((t) => `[${t}](${toolLink(id, t)})`).join(", "),
        restricted.has(p) ? "yes" : "",
        grantable.has(p) ? "yes" : "",
        roles
          .filter(([, r]) => list(r.permissions).includes(p))
          .map(([k]) => code(`${id}.${k}`))
          .join(", "),
        cell(labels[p] ?? ""),
      ]),
    )}`,
    "## Roles",
  ];
  if (!roles.length) parts.push("This pack declares no roles.");
  for (const [k, r] of roles) {
    parts.push(`### ${r.label} (${code(`${id}.${k}`)})`);
    parts.push(inline(r.description));
    const rows = [
      ["Permissions", codes(r.permissions) || "none"],
      ["Reads", codes(r.read) || "no records"],
    ];
    if (r.today) rows.push(["Only today's", codes(Object.keys(r.today))]);
    if (r.looksAfter)
      rows.push(["Only the People its holder looks after", codes(Object.keys(r.looksAfter))]);
    parts.push(table(["", ""], rows));
  }
  const own = tools.filter(
    ([, t]) => t.humanOnly || t.personApproves || t.anyStaff || t.corePermission,
  );
  if (own.length) {
    parts.push(
      `## Who may call, beyond permissions\n\n${table(
        ["Tool", "A person only", "A person approves", "Every staff account", "Core permission"],
        own.map(([n, t]) => [
          `[${n}](${toolLink(id, n)})`,
          t.humanOnly ? "yes" : "",
          t.personApproves ? "yes" : "",
          t.anyStaff ? "yes" : "",
          t.corePermission ? code(t.corePermission) : "",
        ]),
      )}`,
    );
  }
  if (m.staffing) {
    parts.push(
      `## The roster's rules\n\nThis pack sets the host's roster rules (${code("staffing")}).\n\n\`\`\`json\n${JSON.stringify(m.staffing, null, 2)}\n\`\`\``,
    );
  }
  return parts.join("\n\n");
}

function screensPage(id, m, ctx) {
  const screens = Object.entries(m.screens ?? {});
  const parts = [
    "Screens a shipped pack declares are built into the admin and shown to whoever could call every tool in `opens`. Blocks are the pack's screens for client apps, copied with `cos add`.",
    `## Staff screens\n\n${table(
      ["Screen", "Label", "Block", "Navigation", "Opens", "On a record"],
      screens.map(([k, s]) => [
        code(k),
        cell(s.label),
        `[${s.block}](${blockLink(s.block)}) (${code(s.export)})`,
        s.nav ? cell(`${s.nav.group}${s.nav.order !== undefined ? `, ${s.nav.order}` : ""}`) : "",
        list(s.opens)
          .map((t) => `[${t}](${toolLink(id, t)})`)
          .join(", ") + (s.writes ? ` writes ${codes(s.writes)}` : ""),
        s.record ? code(s.record.object) : "",
      ]),
      "This pack declares no staff screens.",
    )}`,
  ];
  const own = ctx.blocks.filter((b) => b.pack === id);
  parts.push(
    `## Blocks\n\n${table(
      ["Block", "Skin", "What it shows"],
      own.map((b) => [`[${b.name}](${blockLink(b.name)})`, b.skin, cell(firstSentence(b.shows))]),
      "This pack has no blocks.",
    )}`,
  );
  return parts.join("\n\n");
}

function messagesPage(_id, m) {
  const kinds = Object.entries(m.routineMail ?? {});
  const signals = Object.entries(m.journeySignals ?? {});
  return [
    "Routine mail is email about this pack's records that the host sends without a person's approval; an admin can turn each kind off.",
    `## Routine message kinds\n\n${table(
      ["Kind", "Label", "About", "When and to whom", "Values it fills"],
      kinds.map(([k, r]) => [
        code(k),
        cell(r.label),
        code(r.about ?? ""),
        cell(r.description),
        codes(Object.keys(r.slots ?? {})),
      ]),
      "This pack sends no routine mail.",
    )}`,
    `## Journey signals\n\n${table(
      ["Signal", "Label", "Object", "State"],
      signals.map(([k, s]) => [
        code(k),
        cell(s.label),
        code(s.object ?? ""),
        cell(list(s.state ?? s.states).join(", ")),
      ]),
      "This pack declares no journey signals.",
    )}`,
  ].join("\n\n");
}

function settingsPage(_id, m) {
  return `Settings are typed, edited in Settings → Extensions. A setting that is a person's to change waits for a person when anyone else changes it.\n\n${table(
    ["Setting", "Type", "Label", "Default", "Limits", "Description"],
    Object.entries(m.settings ?? {}).map(([k, s]) => [
      code(k),
      code(s.type),
      cell(s.label),
      s.default !== undefined ? code(JSON.stringify(s.default)) : "",
      cell(
        [
          s.min !== undefined ? `min ${s.min}` : "",
          s.max !== undefined ? `max ${s.max}` : "",
          s.options ? `one of ${s.options.map((o) => o.value).join(", ")}` : "",
          s.personApproves ? "a person's to change" : "",
          s.required ? "required" : "",
        ]
          .filter(Boolean)
          .join("; "),
      ),
      cell(s.description),
    ]),
    "This pack has no settings.",
  )}`;
}

function packPages(id, ctx) {
  const m = ctx.facts.packs[id];
  const o = ctx.packOverviews[id];
  const title = o?.title ?? m.label ?? id;
  const base = `packs/${id}`;
  const out = [];
  // A pack with an overview has its overview and decisions pages from files alone (buildPages).
  if (!o) {
    const refs = PACK_PAGES.map(([p, label]) => `- [${label}](/${base}/${p}/)`).join("\n");
    out.push({
      path: `${base}/index.md`,
      code: true,
      content: page(
        { title, description: m.description, order: 0, label: "Overview" },
        `${inline(m.description)}\n\nThis pack's overview (${code(`packs/${id}/docs/overview.md`)}) is not written yet. Its reference pages are generated from its manifest:\n\n${refs}`,
      ),
    });
    out.push({
      path: `${base}/decisions.md`,
      code: true,
      content: page(
        { title: `${title}: decisions`, label: "Decisions", order: 90 },
        "The decisions are listed in the pack's overview, which is not written yet.",
      ),
    });
  }
  const sub = {
    "data-model": dataModelPage,
    tools: toolsPage,
    permissions: permissionsPage,
    screens: screensPage,
    messages: messagesPage,
    settings: settingsPage,
  };
  PACK_PAGES.forEach(([p, label], i) => {
    if (!sub[p]) return;
    out.push({
      path: `${base}/${p}.md`,
      code: true,
      content: page(
        { title: `${title}: ${label.toLowerCase()}`, label, order: i + 1 },
        sub[p](id, m, ctx),
      ),
    });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Capabilities

function capabilityPages(c, ctx) {
  const base = `capabilities/${c.id}`;
  const out = [overviewPage(c, base, CAPABILITY_PAGES, ctx), decisionsPage(c, base, ctx)];
  const screens = c.blocks.map((name) => {
    const b = ctx.blocks.find((x) => x.name === name);
    if (!b) ctx.problems.push(`${c.path}: block ${name} does not exist`);
    return b;
  });
  out.push({
    path: `${base}/screens.md`,
    code: false,
    content: page(
      { title: `${c.title}: screens`, label: "Screens", order: 4 },
      `Its blocks, for client apps (copied with \`cos add\`) and the admin.\n\n${table(
        ["Block", "Skin", "What it shows"],
        screens
          .filter(Boolean)
          .map((b) => [`[${b.name}](${blockLink(b.name)})`, b.skin, cell(firstSentence(b.shows))]),
      )}`,
    ),
  });
  if (!ctx.facts) return out;
  const ops = ctx.facts.operations.filter((op) => c.operations.some((p) => op.name.startsWith(p)));
  if (!ops.length) ctx.problems.push(`${c.path}: no operation matches its prefixes`);
  out.push({
    path: `${base}/operations.md`,
    code: true,
    content: page(
      { title: `${c.title}: operations`, label: "Operations", order: 1 },
      `The core operations that are this capability's (named ${c.operations.map(code).join(", ")}). Each links to its full reference, with its input and output.\n\n${table(
        ["Operation", "What it does", "Audiences", "Risk", "Permission"],
        ops.map((op) => [
          `[${code(op.name)}](${opLink(op.name)})`,
          cell(op.description),
          codes(op.audiences ?? ["staff"]),
          code(op.risk),
          code(op.permission),
        ]),
      )}`,
    ),
  });
  const perms = new Map();
  for (const op of ops) {
    if (!perms.has(op.permission)) perms.set(op.permission, []);
    perms.get(op.permission).push(op);
  }
  out.push({
    path: `${base}/permissions.md`,
    code: true,
    content: page(
      { title: `${c.title}: permissions`, label: "Permissions", order: 2 },
      `The permissions its operations need, and which of them only a person may call.\n\n${table(
        ["Permission", "Operations", "A person only"],
        [...perms].map(([p, list]) => [
          code(p),
          list.map((op) => `[${code(op.name)}](${opLink(op.name)})`).join(", "),
          list
            .filter((op) => op.actors && op.actors.length === 1 && op.actors[0] === "human")
            .map((op) => code(op.name))
            .join(", "),
        ]),
      )}`,
    ),
  });
  const defs = ctx.facts.behaviours.filter((b) => c.behaviours.includes(b.key));
  out.push({
    path: `${base}/behaviours.md`,
    code: true,
    content: page(
      { title: `${c.title}: behaviours`, label: "Behaviours", order: 3 },
      defs.length
        ? defs
            .map(
              (b) =>
                `## ${b.key}\n\n${inline(b.doc)}\n\nDeclared on: ${
                  declaredBy(b.key, ctx).join(", ") || "no shipped pack yet"
                }. [The behaviour's reference](${behaviourLink(b.key)}).`,
            )
            .join("\n\n")
        : "It adds no behaviour of its own.",
    ),
  });
  return out;
}

function declaredBy(key, ctx) {
  const out = [];
  for (const [id, m] of Object.entries(ctx.facts.packs)) {
    for (const [name, o] of Object.entries(m.objects ?? {})) {
      if (o[key] !== undefined) out.push(`[${code(`${id}.${name}`)}](/packs/${id}/data-model/)`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Reference

function operationPages(ctx) {
  const groups = new Map();
  for (const op of ctx.facts.operations) {
    const g = opGroup(op.name);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(op);
  }
  const names = [...groups.keys()].sort();
  const out = [
    {
      path: "reference/operations/index.md",
      code: true,
      content: page(
        { title: "Core operations", order: 0, label: "All operations" },
        `Every operation in the core registry (${ctx.facts.operations.length} of them), grouped by the first part of its name. Anything a user can do is an operation, with zod schemas, a model-facing description, a permission, a risk class and the audiences that may call it. The UI, MCP, the HTTP surface and extension code call operations.\n\n${table(
          ["Group", "Operations"],
          names.map((g) => [
            `[${code(g)}](/reference/operations/${groupPath(g)}/)`,
            String(groups.get(g).length),
          ]),
        )}`,
      ),
    },
  ];
  for (const g of names) {
    const ops = groups.get(g).sort((a, b) => a.name.localeCompare(b.name));
    const body = ops
      .map((op) => {
        const rows = [
          ["Permission", code(op.permission)],
          ["Risk", code(op.risk)],
          ["Audiences", codes(op.audiences ?? ["staff"])],
        ];
        if (op.actors) rows.push(["Actors", codes(op.actors)]);
        const flags = [
          op.toolOnly && "called only from a tool's run (`toolOnly`)",
          op.hostInternal && "host-internal (`hostInternal`)",
          op.deskOnly && "only on the business's enrolled device (`deskOnly`)",
          op.bookkeeping && "bookkeeping, never queued for review",
          op.alwaysReview && "always reviewed",
        ].filter(Boolean);
        if (flags.length) rows.push(["Also", flags.join("; ")]);
        if (op.packPermissions) rows.push(["Pack permissions", codes(op.packPermissions)]);
        if (op.staffInput) rows.push(["Staff-only input", codes(op.staffInput)]);
        return `## ${op.name}\n\n${inline(op.description)}\n\n${table(["", ""], rows)}\n\n### Input\n\n${schemaTable(op.input)}\n\n### Output\n\n${schemaTable(op.output)}`;
      })
      .join("\n\n");
    out.push({
      path: `reference/operations/${groupPath(g)}.md`,
      code: true,
      content: page(
        { title: `${g}.* operations`, description: `The core operations named ${g}.*`, label: g },
        body,
      ),
    });
  }
  return out;
}

function behavioursPage(ctx) {
  const body = ctx.facts.behaviours
    .map(
      (b) =>
        `## ${b.key}\n\n${inline(b.doc)}\n\nDeclared as ${code(`${b.key}: ${b.type}`)} on an object. Declared by: ${
          declaredBy(b.key, ctx).join(", ") || "no shipped pack"
        }.`,
    )
    .join("\n\n");
  return {
    path: "reference/behaviours.md",
    code: true,
    content: page(
      {
        title: "Behaviours",
        description: "What an object may declare, enforced by the host in the write's own batch.",
      },
      `A behaviour is a declarative rule set an object opts into in its manifest, enforced by the host in the same batch as the write, for every actor (ADR 0404). A pack composes behaviours; it never hooks writes. This list is read from ${code("ObjectSpec")} in ${code("packages/sdk/src/contract.ts")}, with the declarations that open records to customers and the public.\n\n${body}`,
    ),
  };
}

function blockPages(ctx) {
  const out = [
    {
      path: "reference/blocks/index.md",
      code: true,
      content: page(
        { title: "Blocks", order: 0, label: "All blocks" },
        `A block is a screen, or part of one, for a pack or the base layer, in a web or a native skin. It is copied into a client app with ${code("cos add <block>")} and is the app's from then on; ${code("cos diff <block>")} shows upstream changes. A block holds no rules: it calls operations through hooks.\n\n${table(
          ["Block", "Skin", "Pack", "What it shows"],
          ctx.blocks.map((b) => [
            `[${b.name}](${blockLink(b.name)})`,
            b.skin,
            b.pack ? `[${b.pack}](/packs/${b.pack}/)` : "base layer",
            cell(firstSentence(b.shows)),
          ]),
        )}`,
      ),
    },
  ];
  for (const b of ctx.blocks) {
    const rows = [
      ["Skin", b.skin],
      ["Pack", b.pack ? `[${b.pack}](/packs/${b.pack}/screens/)` : "the base layer"],
      ["Add it", code(`cos add ${b.name}`)],
      ["Files", codes(b.files)],
      [
        "Depends on",
        list(b.dependsOn)
          .map((d) => `[${d}](${blockLink(d)})`)
          .join(", ") || "nothing",
      ],
      ["Packages", codes(Object.keys(b.packages ?? {})) || "none"],
    ];
    out.push({
      path: `reference/blocks/${b.name}.md`,
      code: true,
      content: page(
        { title: b.name, description: firstSentence(b.shows) },
        `${inline(b.shows) || "Its files say nothing about what it shows."}\n\n${table(["", ""], rows)}\n\n## Operations it calls\n\nThrough its hooks; the host decides what each caller may do.\n\n${
          list(b.operations)
            .map((o) => `- ${operationRef(o, ctx)}`)
            .join("\n") || "None."
        }\n\nSource: [${b.dir}](${ctx.repository}/tree/main/${b.dir}).`,
      ),
    });
  }
  return out;
}

function gatekeeperPages(ctx) {
  const out = [
    {
      path: "reference/gatekeepers/index.md",
      code: true,
      content: page(
        { title: "Gatekeepers", order: 0, label: "All gatekeepers" },
        `Extension code runs with no network of its own. External access goes only through gatekeepers: Workers that hold the credentials, check every call against a typed contract and put each outbound change through the approval queue where it needs one. An extension asks for a gatekeeper as a host module by name.\n\n${table(
          ["Gatekeeper", "Host module", "Worker", "What it is"],
          ctx.gatekeepers.map((g) => [
            `[${g.id}](/reference/gatekeepers/${g.id}/)`,
            g.module ? code(g.module) : "",
            g.worker ? "yes" : "",
            cell(g.description),
          ]),
        )}`,
      ),
    },
  ];
  for (const g of ctx.gatekeepers) {
    const contract = g.contract
      ? `## The contract\n\nThe types extension code sees (${code(g.contractPath)}):\n\n\`\`\`ts\n${g.contract.trim()}\n\`\`\``
      : g.contractPath
        ? `## Source\n\n${inline(g.header)}\n\nSee [${g.contractPath}](${repoUrl(ctx, g.contractPath)}).`
        : "";
    out.push({
      path: `reference/gatekeepers/${g.id}.md`,
      code: true,
      content: page(
        { title: g.id, description: g.description },
        `${inline(g.description)}\n\n${table(
          ["", ""],
          [
            ["Package", code(g.name)],
            [
              "Host module",
              g.module ? code(g.module) : "none: a library or contract other gatekeepers use",
            ],
            ["Deployed as a Worker", g.worker ? "yes" : "no"],
            ["Source", `[${g.dir}](${ctx.repository}/tree/main/${g.dir})`],
          ],
        )}\n\n${contract}`,
      ),
    });
  }
  return out;
}

function cliPage(ctx) {
  // A line at the left margin starting with a capital is a section's heading ("A client repo",
  // "Options"); the first line and the last ("cos: …", "Nothing is sent …") stay in the text.
  const sections = [{ heading: null, lines: [] }];
  for (const line of ctx.facts.help.replace(/\s+$/, "").split("\n")) {
    if (/^[A-Z]/.test(line) && !line.startsWith("Nothing is sent")) {
      sections.push({ heading: line.trim(), lines: [] });
    } else {
      sections.at(-1).lines.push(line);
    }
  }
  const body = sections
    .filter((s) => s.heading || s.lines.join("").trim())
    .map(
      (s) =>
        `${s.heading ? `## ${s.heading}\n\n` : ""}\`\`\`text\n${s.lines.join("\n").replace(/^\n+|\n+$/g, "")}\n\`\`\``,
    )
    .join("\n\n");
  return {
    path: "reference/cli.md",
    code: true,
    content: page(
      {
        title: "The cos command",
        description: "Every command of the cos CLI, as its own help gives them.",
      },
      `${code("cos")} is the one command for a company's own repository and for installing a product with no repository. This page is its ${code("--help")}, read from ${code("packages/create-composable-os/src/main.ts")}.\n\n${body}`,
    ),
  };
}

function glossaryPage(ctx) {
  const body = ctx.glossary
    .map((s) => {
      const head = s.heading ? `## ${s.heading}\n\n` : "";
      const intro = s.intro ? `${rewriteLinks(s.intro, "CONTEXT.md", ctx)}\n\n` : "";
      const entries = s.entries
        .map(
          (e) =>
            `### ${e.term}\n\n${e.note ? `${rewriteLinks(e.note, "CONTEXT.md", ctx)}\n\n` : ""}${rewriteLinks(e.body, "CONTEXT.md", ctx)}`,
        )
        .join("\n\n");
      return `${head}${intro}${entries}`;
    })
    .join("\n\n");
  return {
    path: "reference/glossary.md",
    code: false,
    content: page(
      { title: "Glossary", description: "The words Composable OS uses, from CONTEXT.md." },
      `The words used in the code, the docs and the UI, read from [CONTEXT.md](${repoUrl(ctx, "CONTEXT.md")}). _Avoid_ names words not to use for the term.\n\n${body}`,
    ),
  };
}

function solutionPages(ctx) {
  const packRow = (id) => {
    const m = ctx.facts.packs[id];
    return [`[${m?.label ?? id}](/packs/${id}/)`, cell(firstSentence(m?.description ?? ""))];
  };
  const out = [];
  const products = ctx.facts.products;
  out.push({
    path: "solutions/index.md",
    code: true,
    content: page(
      { title: "Solutions", order: 0, label: "All solutions" },
      `A solution is a product: a named composition of packs on the platform, defined in a product definition. Each product in this repository is listed here with the packs it is made of, and a company's own product starts from the client template.\n\n${table(
        ["Solution", "Packs"],
        [
          ...products.map((p) => [
            `[${p.label}](/solutions/${p.id}/)`,
            list(p.packs)
              .map((x) => `[${x}](/packs/${x}/)`)
              .join(", "),
          ]),
          ["[A company's own product](/solutions/client/)", "the packs it chooses"],
        ],
      )}`,
    ),
  });
  for (const p of products) {
    out.push({
      path: `solutions/${p.id}.md`,
      code: true,
      content: page(
        { title: p.label, description: `The ${p.label} product: the packs it is made of.` },
        `Defined in [products/${p.id}/product.ts](${repoUrl(ctx, `products/${p.id}/product.ts`)}). A deployment of it names its Workers and resources from its names (${codes(Object.values(p.names ?? {}))}).\n\n## Its packs\n\n${table(["Pack", "What it is"], list(p.packs).map(packRow))}`,
      ),
    });
  }
  out.push({
    path: "solutions/client.md",
    code: true,
    content: page(
      {
        title: "A company's own product",
        description: "A client repository's product definition and the packs it can turn on.",
      },
      `A company's own product lives in its own repository, made with ${code("cos create")} or adopted with ${code("cos init")} from the client template ([templates/client](${ctx.repository}/tree/main/templates/client)). Its ${code("product.ts")} lists the packs that are on (none by default: base records only) and ${code("cos deploy")} installs them. Any pack the release carries can be listed:\n\n${table(["Pack", "What it is"], ctx.packIds.map(packRow))}`,
    ),
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Guides, planned work and the hand-written site pages (files only)

function guidePages(ctx) {
  return ctx.guides.map((g) => {
    if (!g.title) ctx.problems.push(`${g.path}: front matter needs a title`);
    return {
      path: `guides/${g.id}.md`,
      code: false,
      content: page(
        { title: g.title ?? g.id, description: g.description, order: g.order },
        `${rewriteLinks(g.body, g.path, ctx)}\n\nThis guide is [${g.path}](${repoUrl(ctx, g.path)}), written by hand beside the code.`,
      ),
    };
  });
}

function plannedPage(ctx) {
  const documented = new Set(
    [
      ...Object.values(ctx.packOverviews).map((o) => o.stage),
      ...Object.values(ctx.capabilityOverviews).map((o) => o.stage),
      ...Object.values(ctx.pending).map((p) => String(p.stage)),
    ].filter(Boolean),
  );
  const rows = ctx.stages
    .filter((s) => s.spec && !documented.has(s.stage))
    .map(
      (s) =>
        `- **${s.name}** (stage ${s.stage}): ${inline(firstSentence(s.scope)).replace(/\.?$/, ".")} [Its spec](${repoUrl(ctx, s.spec)}).`,
    );
  return {
    path: "planned.md",
    code: false,
    content: page(
      {
        title: "Planned",
        description: "Stages with a spec and no pack or capability pages here yet.",
      },
      `Stages that have a spec and no pack or capability pages on this site yet, from [docs/roadmap.md](${repoUrl(ctx, "docs/roadmap.md")}). Pieces of them that are already in the code appear in the reference (operations, behaviours, blocks).\n\n${rows.join("\n")}`,
    ),
  };
}

function sitePages(ctx) {
  const dir = join(ctx.root, "apps", "docs", "content");
  return ["index.md", "versions.md"].map((name) => ({
    path: name,
    code: false,
    content: rewriteLinks(readFileSync(join(dir, name), "utf8"), `apps/docs/content/${name}`, ctx),
  }));
}

/** Every page. Without `ctx.facts` (the documents lane), only the pages that need no code. */
export function buildPages(ctx) {
  const pages = [...sitePages(ctx), ...guidePages(ctx), glossaryPage(ctx), plannedPage(ctx)];
  for (const o of Object.values(ctx.packOverviews)) {
    pages.push(
      overviewPage(o, `packs/${o.id}`, PACK_PAGES, ctx),
      decisionsPage(o, `packs/${o.id}`, ctx),
    );
  }
  for (const c of Object.values(ctx.capabilityOverviews)) pages.push(...capabilityPages(c, ctx));
  if (ctx.facts) {
    pages.push(
      {
        path: "packs/index.md",
        code: true,
        content: page(
          { title: "Packs", order: 0, label: "All packs" },
          `A pack is a shipped extension with its headless client hooks and its blocks, released with the platform and turned on per product. Each one's pages are generated from its manifest (${code("packs/<id>/index.ts")}), with an overview written beside it.\n\n${table(
            ["Pack", "What it is", "Requires"],
            ctx.packIds.map((id) => {
              const m = ctx.facts.packs[id];
              return [
                `[${ctx.packOverviews[id]?.title ?? m.label ?? id}](/packs/${id}/)`,
                cell(firstSentence(m.description ?? "")),
                list(m.requires)
                  .map((r) => `[${r}](/packs/${r}/)`)
                  .join(", "),
              ];
            }),
          )}`,
        ),
      },
      {
        path: "capabilities/index.md",
        code: true,
        content: page(
          { title: "Capabilities", order: 0, label: "All capabilities" },
          `A capability is platform work any pack composes: core tables, operations and behaviours, with blocks for client apps. Those documented as a unit are listed here; everything else in the core is in the reference.\n\n${table(
            ["Capability", "What it is"],
            Object.values(ctx.capabilityOverviews).map((c) => [
              `[${c.title}](/capabilities/${c.id}/)`,
              cell(c.summary),
            ]),
          )}`,
        ),
      },
      ...ctx.packIds.flatMap((id) => packPages(id, ctx)),
      ...operationPages(ctx),
      ...blockPages(ctx),
      ...gatekeeperPages(ctx),
      behavioursPage(ctx),
      cliPage(ctx),
      ...solutionPages(ctx),
    );
  }
  return pages;
}

/** The sidebar (src/sidebar.json): needs the code, for each pack's name. */
export function sidebar(ctx) {
  const group = (base, subs, title) => ({
    label: title,
    collapsed: true,
    items: [{ slug: base }, ...subs.map(([p]) => ({ slug: `${base}/${p}` }))],
  });
  const opGroups = [...new Set(ctx.facts.operations.map((o) => opGroup(o.name)))].sort();
  return [
    { label: "Start", items: [{ slug: "index" }, { slug: "versions" }, { slug: "planned" }] },
    { label: "Guides", items: [{ autogenerate: { directory: "guides" } }] },
    {
      label: "Packs",
      items: [
        { slug: "packs" },
        ...ctx.packIds.map((id) =>
          group(
            `packs/${id}`,
            PACK_PAGES,
            ctx.packOverviews[id]?.title ?? ctx.facts.packs[id].label ?? id,
          ),
        ),
      ],
    },
    {
      label: "Capabilities",
      items: [
        { slug: "capabilities" },
        ...Object.values(ctx.capabilityOverviews).map((c) =>
          group(`capabilities/${c.id}`, CAPABILITY_PAGES, c.title),
        ),
      ],
    },
    { label: "Solutions", items: [{ autogenerate: { directory: "solutions" } }] },
    {
      label: "Reference",
      items: [
        {
          label: "Core operations",
          collapsed: true,
          items: [
            { slug: "reference/operations" },
            ...opGroups.map((g) => ({ slug: `reference/operations/${groupPath(g)}` })),
          ],
        },
        { slug: "reference/behaviours" },
        {
          label: "Blocks",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference/blocks" } }],
        },
        {
          label: "Gatekeepers",
          collapsed: true,
          items: [{ autogenerate: { directory: "reference/gatekeepers" } }],
        },
        { slug: "reference/cli" },
        { slug: "reference/glossary" },
      ],
    },
  ];
}
