/**
 * RynL10n 대시보드 (어드민 앱) — 기획서 7.1 / 9.2 코어 ③.
 *
 * 프레임워크·번들러 없는 바닐라 ES 모듈. 저장소 전체의 "외부 런타임 의존성 0 · 빌드 스텝 없음"
 * 원칙을 그대로 따른다(에어갭 배포 9.4에서도 파일 그대로 동작).
 *
 * 이 앱은 **관리 플레인(:8787)만** 호출한다. 배포 플레인(:8788)은 산출물 링크로만 노출하며
 * 대시보드가 그 위에 어떤 애플리케이션 로직도 얹지 않는다(플레인 분리 4.1).
 */

// ── DOM 헬퍼 ────────────────────────────────────────────────────────────────
// 모든 사용자 데이터는 textContent/value로만 주입한다(innerHTML 미사용 → XSS 차단).

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

const $app = () => document.getElementById("app");

function mount(...nodes) {
  const app = $app();
  app.className = "";
  app.replaceChildren(...nodes.flat().filter(Boolean));
}

function toast(kind, title, detail) {
  const box = el("div", { class: `toast ${kind}` },
    el("div", { class: "title", text: title }),
    detail ? el("div", { class: "detail", text: detail }) : null,
  );
  document.getElementById("toasts").append(box);
  setTimeout(() => box.remove(), kind === "error" ? 9000 : 4000);
}

// ── API 클라이언트 ───────────────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, code, message) {
    super(message || `HTTP ${status}`);
    this.status = status;
    this.code = code;
  }
}

const enc = encodeURIComponent;

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 비 JSON 응답 */ }
  if (!res.ok) throw new ApiError(res.status, data?.error?.code, data?.error?.message);
  return data;
}

/** 실패를 토스트로 표면화하는 공통 래퍼. 에러 코드별로 원인을 사람 말로 풀어준다. */
async function run(label, fn) {
  try {
    const out = await fn();
    if (label) toast("ok", label);
    return out;
  } catch (e) {
    if (!(e instanceof ApiError)) { toast("error", "요청 실패", String(e.message ?? e)); return undefined; }
    if (e.status === 401) { logout(); toast("error", "인증이 만료됐습니다", "토큰을 다시 입력하세요."); return undefined; }
    toast("error", EXPLAIN[e.code] ?? `실패 (HTTP ${e.status})`, e.message);
    return undefined;
  }
}

const EXPLAIN = {
  signature_mismatch: "422 — 플레이스홀더 서명 불일치",
  range_conflict: "409 — 앱 버전 범위 충돌",
  forbidden: "403 — 권한 부족",
  not_found: "404 — 대상을 찾을 수 없음",
  bad_request: "400 — 요청이 올바르지 않음",
};

// ── 상태 ─────────────────────────────────────────────────────────────────────

const state = {
  token: localStorage.getItem("rynl10n.token") ?? "",
  me: null,          // {actor, role, projects, deliveryBaseUrl}
  projects: [],
  projectId: null,
  project: null,     // {id,name,defaultLocale,locales}
  keys: [],          // [{name, signature, isPlural, refCount, translations}]
  releases: [],
  manifest: null,
  history: [],
  tab: "translations",
  live: false,
};

const ROLE_CAPS = {
  viewer: ["read"],
  translator: ["read", "edit_translation"],
  maintainer: ["read", "edit_translation", "manage_release"],
  admin: ["read", "edit_translation", "manage_release", "admin"],
};
/** 현재 토큰 역할이 해당 권한을 갖는지 — 서버 RBAC(7.3)의 UI 미러. 최종 판정은 항상 서버. */
const can = (cap) => (ROLE_CAPS[state.me?.role] ?? []).includes(cap);

function deliveryBase() {
  return state.me?.deliveryBaseUrl || `${location.protocol}//${location.hostname}:8788`;
}

// ── 인증 ─────────────────────────────────────────────────────────────────────

function logout() {
  localStorage.removeItem("rynl10n.token");
  state.token = "";
  state.me = null;
  closeStream();
  renderLogin();
}

function renderLogin(error) {
  const input = el("input", {
    type: "password", placeholder: "Bearer 토큰", class: "grow",
    autocomplete: "off", value: state.token,
  });
  const submit = async () => {
    state.token = input.value.trim();
    if (!state.token) return;
    try {
      state.me = await api("GET", "/me");
      localStorage.setItem("rynl10n.token", state.token);
      await openProjects();
    } catch (e) {
      state.token = "";
      renderLogin(e.status === 401 ? "유효하지 않은 토큰입니다." : e.message);
    }
  };
  mount(el("main", {},
    el("div", { class: "panel login" },
      el("h2", { text: "RynL10n 대시보드" }),
      el("p", { class: "small" },
        "관리 API 토큰으로 로그인합니다. 로컬 실행 기본값은 ",
        el("code", { text: "dev-admin-token" }),
        " 이고, Docker는 ",
        el("code", { text: "RYNL10N_ADMIN_TOKEN" }),
        " 환경 변수로 주입합니다.",
      ),
      el("div", { class: "row" }, input,
        el("button", { class: "primary", onClick: submit, text: "로그인" }),
      ),
      error ? el("p", { class: "small", style: "color:var(--danger)", text: error }) : null,
      el("p", { class: "small muted" },
        "토큰은 이 브라우저의 localStorage에만 저장되며 대시보드는 관리 플레인만 호출합니다.",
      ),
    ),
  ));
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
  input.focus();
}

// ── 공통 셸 ──────────────────────────────────────────────────────────────────

function shell(...content) {
  const crumb = state.project
    ? el("button", { class: "link", text: "← 프로젝트 목록", onClick: () => openProjects() })
    : null;
  mount(
    el("header", { class: "top" },
      el("h1", { text: "RynL10n" }),
      crumb,
      state.project ? el("span", { class: "muted small", text: `${state.project.name} (${state.project.id})` }) : null,
      el("span", { class: "spacer" }),
      state.projectId
        ? el("span", { class: `badge ${state.live ? "live" : "off"}`, text: state.live ? "실시간 연결됨" : "실시간 끊김" })
        : null,
      el("span", { class: "who", text: `${state.me.actor} · ${state.me.role}` }),
      el("button", { class: "tiny", text: "로그아웃", onClick: logout }),
    ),
    el("main", {}, ...content.flat().filter(Boolean)),
  );
}

// ── 프로젝트 목록 ────────────────────────────────────────────────────────────

async function openProjects() {
  closeStream();
  state.projectId = null; state.project = null;
  const data = await api("GET", "/projects");
  state.projects = data.projects;
  renderProjects();
}

function renderProjects() {
  const rows = state.projects.map((p) =>
    el("tr", {},
      el("td", {}, el("button", { class: "link", text: p.id, onClick: () => openProject(p.id) })),
      el("td", { text: p.name }),
      el("td", { class: "mono", text: p.defaultLocale }),
    ),
  );

  const idInput = el("input", { placeholder: "project-id", class: "grow" });
  const nameInput = el("input", { placeholder: "표시 이름", class: "grow" });
  const localeInput = el("input", { placeholder: "en", size: "8" });
  const extraInput = el("input", { placeholder: "ko, ja (쉼표 구분)", class: "grow" });

  const create = async () => {
    const id = idInput.value.trim(), name = nameInput.value.trim(), defaultLocale = localeInput.value.trim();
    if (!id || !name || !defaultLocale) { toast("error", "id · 이름 · 기본 로케일은 필수입니다"); return; }
    const locales = extraInput.value.split(",").map((s) => s.trim()).filter(Boolean);
    const ok = await run("프로젝트를 만들었습니다", () =>
      api("POST", "/projects", { id, name, defaultLocale, locales }));
    if (ok) { idInput.value = nameInput.value = extraInput.value = ""; await openProjects(); }
  };

  shell(
    el("div", { class: "panel" },
      el("h2", {}, "프로젝트", el("span", { class: "hint", text: "토큰 스코프에 포함된 것만 보입니다" })),
      state.projects.length
        ? el("div", { class: "tablewrap" }, el("table", {},
            el("thead", {}, el("tr", {}, el("th", { text: "ID" }), el("th", { text: "이름" }), el("th", { text: "기본 로케일" }))),
            el("tbody", {}, ...rows),
          ))
        : el("p", { class: "muted", text: "아직 프로젝트가 없습니다." }),
    ),
    can("admin")
      ? el("div", { class: "panel" },
          el("h2", {}, "새 프로젝트",
            el("span", { class: "hint", text: "지원 로케일은 여기서 등록해야 산출물에 포함됩니다" })),
          el("div", { class: "row" },
            el("label", { class: "field grow" }, "프로젝트 ID", idInput),
            el("label", { class: "field grow" }, "이름", nameInput),
            el("label", { class: "field" }, "기본 로케일", localeInput),
            el("label", { class: "field grow" }, "추가 로케일", extraInput),
            el("button", { class: "primary", text: "생성", onClick: create }),
          ),
        )
      : null,
  );
}

// ── 프로젝트 상세 ────────────────────────────────────────────────────────────

async function openProject(id) {
  state.projectId = id;
  const [project, keys, releases] = await Promise.all([
    api("GET", `/projects/${enc(id)}`),
    api("GET", `/projects/${enc(id)}/keys`),
    api("GET", `/projects/${enc(id)}/releases`),
  ]);
  state.project = project;
  state.keys = keys.keys;
  state.releases = releases.releases;
  await loadDelivery();
  openStream(id);
  renderProject();
}

/** manifest·이력은 없을 수 있다(publish 전) — 404는 정상 상태로 처리. */
async function loadDelivery() {
  const id = state.projectId;
  try { state.manifest = await api("GET", `/projects/${enc(id)}/manifest`); }
  catch { state.manifest = null; }
  try { state.history = (await api("GET", `/projects/${enc(id)}/manifests`)).history; }
  catch { state.history = []; }
}

async function refresh({ delivery = true } = {}) {
  const id = state.projectId;
  const [keys, releases] = await Promise.all([
    api("GET", `/projects/${enc(id)}/keys`),
    api("GET", `/projects/${enc(id)}/releases`),
  ]);
  state.keys = keys.keys;
  state.releases = releases.releases;
  state.project = await api("GET", `/projects/${enc(id)}`);
  if (delivery) await loadDelivery();
  renderProject();
}

const TABS = [
  ["translations", "번역"],
  ["releases", "릴리스"],
  ["delivery", "배포"],
];

function renderProject() {
  const tabs = el("nav", { class: "tabs" }, ...TABS.map(([id, label]) =>
    el("button", {
      text: label,
      "aria-current": String(state.tab === id),
      onClick: () => { state.tab = id; renderProject(); },
    }),
  ));
  const body = state.tab === "translations" ? tabTranslations()
    : state.tab === "releases" ? tabReleases()
    : tabDelivery();
  shell(tabs, body);
}

// ── 탭: 번역 ────────────────────────────────────────────────────────────────

function tabTranslations() {
  const locales = state.project.locales;
  const editable = can("edit_translation");

  const head = el("tr", {},
    el("th", { text: "키" }),
    el("th", {}, "설명", el("span", { class: "muted", text: " (번역자용)" })),
    ...locales.map((l) => el("th", {}, l, l === state.project.defaultLocale ? el("span", { class: "muted", text: " (기본)" }) : null)),
    el("th", { text: "릴리스" }),
  );

  const rows = state.keys.map((k) => el("tr", {},
    el("td", { class: "key" }, k.name,
      k.isPlural ? el("div", {}, el("span", { class: "badge", text: "복수형" })) : null,
      k.signature ? el("div", { class: "small muted", text: `서명: ${k.signature}` }) : null,
    ),
    descriptionCell(k, editable),
    ...locales.map((l) => translationCell(k, l, editable)),
    el("td", { class: "small muted", text: `${k.refCount}개` }),
  ));

  return [
    el("div", { class: "panel" },
      el("h2", {}, "지원 로케일",
        el("span", { class: "hint", text: "여기 없는 로케일의 번역은 스냅샷에서 제외됩니다" })),
      el("div", { class: "row" },
        ...locales.map((l) => el("span", { class: "badge", text: l })),
        can("manage_release") ? localeAdder() : null,
      ),
    ),
    el("div", { class: "panel" },
      el("h2", {}, "번역",
        el("span", { class: "hint", text: "값을 고치고 Enter 또는 포커스 아웃으로 저장합니다" })),
      editable ? keyAdder() : null,
      state.keys.length
        ? el("div", { class: "tablewrap" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...rows)))
        : el("p", { class: "muted", text: "키가 없습니다. 위에서 추가하세요." }),
    ),
  ];
}

/**
 * 키 설명 셀(5.1) — 로케일이 아니라 '의미'에 붙는 메타라 키 단위 한 칸이다.
 * 나중에 로케일을 늘릴 때 번역자가 읽는 맥락이며, 런타임 산출물에는 실리지 않는다.
 */
function descriptionCell(key, editable) {
  const box = el("textarea", {
    rows: "2", disabled: !editable,
    placeholder: "이 문구가 쓰이는 화면·맥락·톤 — 이후 로케일을 늘릴 때 번역자가 읽습니다",
  });
  box.value = key.description ?? ""; // textarea는 속성이 아니라 value로 채운다

  let last = box.value;
  box.addEventListener("blur", async () => {
    if (box.value === last) return;
    const ok = await run("설명을 저장했습니다", () => api(
      "PUT", `/projects/${enc(state.projectId)}/keys/${enc(key.name)}`, { description: box.value },
    ));
    if (ok) { last = box.value; await refresh({ delivery: false }); }
    else box.value = last;
  });
  return el("td", { class: "desc" }, box);
}

function translationCell(key, locale, editable) {
  const t = key.translations[locale];
  const raw = t === undefined ? "" : (typeof t.value === "string" ? t.value : JSON.stringify(t.value));
  const input = el("input", {
    value: raw, disabled: !editable,
    placeholder: key.isPlural ? '{"one":"…","other":"…"}' : "미번역",
  });
  const stateChip = el("button", {
    class: `badge ${t?.state ?? "draft"} tiny`,
    text: t?.state ?? "—",
    title: t ? `상태: ${t.state} · 수정: ${t.updatedAt}` : "아직 값이 없습니다",
    disabled: !editable || !t,
    onClick: () => save(t.state === "reviewed" ? "draft" : "reviewed"),
  });

  let last = raw;
  async function save(nextState) {
    const text = input.value;
    const target = nextState ?? t?.state ?? "draft";
    if (text === last && nextState === undefined) return;      // 변경 없음
    if (text === "" && t === undefined) return;                // 빈 칸 그대로면 요청 없음

    let value = text;
    if (key.isPlural) {
      try { value = JSON.parse(text); }
      catch { toast("error", "복수형 값은 JSON 객체여야 합니다", 'CLDR 카테고리 맵 예: {"one":"1개","other":"{n}개"}'); return; }
    }
    const ok = await run(null, () => api(
      "PUT", `/projects/${enc(state.projectId)}/translations/${enc(key.name)}/${enc(locale)}`,
      { value, state: target },
    ));
    if (ok) { last = text; await refresh({ delivery: false }); }
    else input.value = last; // 실패 시 마지막 저장값으로 되돌림(422 서명 불일치 등)
  }

  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
  input.addEventListener("blur", () => save());

  return el("td", { class: "cell" }, el("div", { class: "row" }, input, stateChip));
}

function localeAdder() {
  const tag = el("input", { placeholder: "ko-KR", size: "10" });
  const add = async () => {
    if (!tag.value.trim()) return;
    const ok = await run("로케일을 추가했습니다", () =>
      api("POST", `/projects/${enc(state.projectId)}/locales`, { tag: tag.value.trim() }));
    if (ok) { tag.value = ""; await refresh({ delivery: false }); }
  };
  tag.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  return el("span", { class: "row" }, tag, el("button", { class: "tiny", text: "로케일 추가", onClick: add }));
}

function keyAdder() {
  const name = el("input", { placeholder: "namespace.key", class: "grow" });
  const plural = el("input", { type: "checkbox" });
  const desc = el("textarea", {
    rows: "2",
    placeholder: "설명(선택) — 이 문구가 쓰이는 화면·맥락·톤. 이후 로케일을 늘릴 때 번역자가 읽습니다",
  });
  const add = async () => {
    if (!name.value.trim()) return;
    const ok = await run("키를 추가했습니다", () => api(
      "PUT", `/projects/${enc(state.projectId)}/keys/${enc(name.value.trim())}`,
      { isPlural: plural.checked, description: desc.value.trim() },
    ));
    if (ok) { name.value = ""; desc.value = ""; plural.checked = false; await refresh({ delivery: false }); }
  };
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });
  return el("div", { style: "margin-bottom:12px" },
    el("div", { class: "row" },
      name,
      el("label", { class: "row small muted" }, plural, "복수형(CLDR 카테고리 맵)"),
      el("button", { text: "키 추가", onClick: add }),
    ),
    el("div", { style: "margin-top:6px" }, desc),
  );
}

// ── 탭: 릴리스 ──────────────────────────────────────────────────────────────

function tabReleases() {
  const manage = can("manage_release");
  const rows = state.releases.map((r) => el("tr", {},
    el("td", { class: "mono" }, r.id, el("div", { class: "small muted", text: r.name })),
    el("td", {}, el("span", { class: `badge ${r.state}`, text: r.state })),
    el("td", { class: "small mono" }, r.versionMatch.value,
      el("div", { class: "small muted", text: r.versionMatch.strategy })),
    el("td", { class: "small mono" },
      r.base ? el("div", { text: `base ${r.base}` }) : el("span", { class: "muted", text: "미게시" }),
      r.overlay && r.overlay !== r.base ? el("div", { text: `overlay ${r.overlay}` }) : null,
    ),
    el("td", { class: "small", text: `${r.rollout}%` }),
    el("td", {}, releaseActions(r, manage)),
  ));

  return [
    el("div", { class: "panel" },
      el("h2", {}, "릴리스",
        el("span", { class: "hint", text: "publish 시 범위가 겹치면 409로 차단됩니다" })),
      state.releases.length
        ? el("div", { class: "tablewrap" }, el("table", {},
            el("thead", {}, el("tr", {},
              el("th", { text: "릴리스" }), el("th", { text: "상태" }), el("th", { text: "버전 매칭" }),
              el("th", { text: "산출물 포인터" }), el("th", { text: "rollout" }), el("th", { text: "작업" }),
            )),
            el("tbody", {}, ...rows),
          ))
        : el("p", { class: "muted", text: "릴리스가 없습니다." }),
    ),
    manage ? releaseCreator() : null,
  ];
}

function releaseActions(r, manage) {
  if (!manage) return el("span", { class: "muted small", text: "읽기 전용" });

  const publish = async () => {
    const res = await run(null, () => api("POST", `/projects/${enc(state.projectId)}/releases/${enc(r.id)}/publish`));
    if (!res) return;
    const job = await run(null, () => api("GET", `/projects/${enc(state.projectId)}/jobs/${enc(res.jobId)}`));
    if (job?.state === "done") toast("ok", `${r.id} 게시 완료`, `base ${job.result?.base} · overlay ${job.result?.overlay}`);
    else toast("error", `${r.id} 게시 실패`, job?.result?.error ?? "잡 상태를 확인하세요");
    await refresh();
  };

  const rollback = async () => {
    const targets = rollbackTargets(r.id);
    if (!targets.length) { toast("error", "되돌릴 이전 산출물이 없습니다", "보존 창(최근 20개) 안에 이전 overlay가 있어야 합니다."); return; }
    const pick = el("select", {}, ...targets.map((t) => el("option", { value: t, text: t })));
    const dialog = confirmPanel(
      `${r.id} 롤백`,
      [el("p", { class: "small muted", text: "manifest의 overlay 포인터를 이전 산출물로 되돌립니다. 산출물은 불변이라 즉시·무손실입니다." }),
       el("label", { class: "field" }, "되돌릴 overlay", pick)],
      async () => {
        const ok = await run(`${r.id} 롤백 완료`, () =>
          api("POST", `/projects/${enc(state.projectId)}/releases/${enc(r.id)}/rollback`, { to: pick.value }));
        if (ok) await refresh();
      },
    );
    dialog();
  };

  const archive = async () => {
    const next = r.state === "archived" ? "draft" : "archived";
    const ok = await run(`${r.id} → ${next}`, () =>
      api("PATCH", `/projects/${enc(state.projectId)}/releases/${enc(r.id)}`, { state: next }));
    if (ok) await refresh();
  };

  const addKeys = () => {
    const missing = state.keys.map((k) => k.name);
    const box = el("select", { multiple: true, size: String(Math.min(8, Math.max(3, missing.length))) },
      ...missing.map((n) => el("option", { value: n, text: n })));
    confirmPanel(
      `${r.id}에 키 추가 (백포트)`,
      [el("p", { class: "small muted", text: "선택한 키를 이 릴리스의 카탈로그에 포함시킵니다. 반영은 다음 publish 때 이뤄집니다." }), box],
      async () => {
        const keys = [...box.selectedOptions].map((o) => o.value);
        if (!keys.length) return;
        const ok = await run("키를 추가했습니다", () =>
          api("POST", `/projects/${enc(state.projectId)}/releases/${enc(r.id)}/keys`, { keys }));
        if (ok) await refresh({ delivery: false });
      },
    )();
  };

  return el("div", { class: "row" },
    el("button", { class: "tiny primary", text: "publish", onClick: publish }),
    el("button", { class: "tiny", text: "키 추가", onClick: addKeys }),
    r.base ? el("button", { class: "tiny", text: "롤백", onClick: rollback }) : null,
    el("button", { class: "tiny danger", text: r.state === "archived" ? "복구" : "보관", onClick: archive }),
  );
}

/** 보존 창(8.3) 이력에서 이 릴리스가 가졌던 이전 overlay 해시들 — 현재 값은 제외. */
function rollbackTargets(releaseId) {
  const current = state.releases.find((r) => r.id === releaseId)?.overlay;
  const seen = new Set();
  for (const h of state.history) {
    const rec = (h.manifest?.releases ?? []).find((x) => x.id === releaseId);
    if (rec?.overlay && rec.overlay !== current) seen.add(rec.overlay);
    if (rec?.base && rec.base !== current) seen.add(rec.base);
  }
  return [...seen];
}

function releaseCreator() {
  const name = el("input", { placeholder: "3.2.x", class: "grow" });
  const strategy = el("select", {},
    el("option", { value: "semver-range", text: "semver-range" }),
    el("option", { value: "exact-label", text: "exact-label" }),
  );
  const value = el("input", { placeholder: ">=3.2.0 <3.3.0", class: "grow" });
  const keyBox = el("select", { multiple: true, size: String(Math.min(8, Math.max(3, state.keys.length || 3))) },
    ...state.keys.map((k) => el("option", { value: k.name, text: k.name })));

  const create = async () => {
    if (!name.value.trim() || !value.value.trim()) { toast("error", "이름과 버전 매칭 값은 필수입니다"); return; }
    const keys = [...keyBox.selectedOptions].map((o) => o.value);
    const ok = await run("릴리스를 만들었습니다", () => api("POST", `/projects/${enc(state.projectId)}/releases`, {
      name: name.value.trim(),
      versionMatch: { strategy: strategy.value, value: value.value.trim() },
      keys,
    }));
    if (ok) { name.value = ""; value.value = ""; await refresh({ delivery: false }); }
  };

  return el("div", { class: "panel" },
    el("h2", {}, "새 릴리스",
      el("span", { class: "hint", text: "semver-range는 명시적 하한·상한만 지원합니다 (^, ~, || 불가)" })),
    el("div", { class: "row" },
      el("label", { class: "field grow" }, "이름", name),
      el("label", { class: "field" }, "매칭 전략", strategy),
      el("label", { class: "field grow" }, "매칭 값", value),
    ),
    el("div", { class: "row", style: "margin-top:10px; align-items:flex-start" },
      el("label", { class: "field grow" }, "포함할 키 (다중 선택)", keyBox),
      el("button", { class: "primary", text: "릴리스 생성", onClick: create }),
    ),
  );
}

// ── 탭: 배포 ────────────────────────────────────────────────────────────────

function tabDelivery() {
  const base = deliveryBase();
  const pid = state.projectId;
  const manifestUrl = `${base}/${pid}/manifest.json`;

  const artifacts = (state.manifest?.releases ?? []).flatMap((r) => [
    r.snapshot ? el("li", {}, el("a", { href: `${base}/${pid}/${r.snapshot}`, target: "_blank", rel: "noreferrer", class: "mono small", text: r.snapshot })) : null,
    r.delta ? el("li", {}, el("a", { href: `${base}/${pid}/${r.delta}`, target: "_blank", rel: "noreferrer", class: "mono small", text: r.delta })) : null,
  ].filter(Boolean));

  const health = el("div", { class: "row" }, ...state.releases.filter((r) => r.base).map((r) =>
    el("button", {
      class: "tiny", text: `${r.id} 건전성`,
      onClick: async () => {
        const h = await run(null, () => api("GET", `/projects/${enc(pid)}/releases/${enc(r.id)}/health`));
        if (h) toast("ok", `${r.id} 배포 건전성`, JSON.stringify(h, null, 2));
      },
    }),
  ));

  const exportProject = async () => {
    const data = await run(null, () => api("GET", `/projects/${enc(pid)}/export`));
    if (!data) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const a = el("a", { href: url, download: `${pid}-export.json` });
    document.body.append(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const rebuild = async () => {
    const ok = await run("산출물을 재생성했습니다", () => api("POST", `/projects/${enc(pid)}/rebuild`));
    if (ok) await refresh();
  };

  return [
    el("div", { class: "panel" },
      el("h2", {}, "배포 플레인",
        el("span", { class: "hint", text: "정적 파일만 — SDK 런타임은 이 경로만 읽습니다" })),
      el("p", { class: "small" }, "manifest: ",
        el("a", { href: manifestUrl, target: "_blank", rel: "noreferrer", class: "mono", text: manifestUrl })),
      artifacts.length ? el("ul", { class: "small" }, ...artifacts) : el("p", { class: "muted small", text: "게시된 산출물이 없습니다." }),
      el("div", { class: "row", style: "margin-top:10px" },
        can("manage_release") ? el("button", { class: "tiny", text: "산출물 재생성 (재해 복구)", onClick: rebuild }) : null,
        can("admin") ? el("button", { class: "tiny", text: "전체 export", onClick: exportProject }) : null,
      ),
      health.childNodes.length ? el("div", { class: "row", style: "margin-top:10px" }, health) : null,
    ),
    el("div", { class: "panel" },
      el("h2", {}, "현재 manifest"),
      state.manifest
        ? el("pre", { class: "json", text: JSON.stringify(state.manifest, null, 2) })
        : el("p", { class: "muted", text: "아직 게시된 manifest가 없습니다. 릴리스를 publish 하세요." }),
    ),
    el("div", { class: "panel" },
      el("h2", {}, "게시 이력",
        el("span", { class: "hint", text: "보존 창 = 최근 20개 (롤백 대상)" })),
      state.history.length
        ? el("div", { class: "tablewrap" }, el("table", {},
            el("thead", {}, el("tr", {}, el("th", { text: "seq" }), el("th", { text: "시각" }), el("th", { text: "릴리스별 overlay" }))),
            el("tbody", {}, ...state.history.map((h) => el("tr", {},
              el("td", { class: "mono", text: String(h.seq) }),
              el("td", { class: "small", text: h.createdAt }),
              el("td", { class: "small mono", text: (h.manifest?.releases ?? []).map((r) => `${r.id}:${r.overlay}`).join("  ") }),
            ))),
          ))
        : el("p", { class: "muted", text: "이력이 없습니다." }),
    ),
  ];
}

// ── 확인 패널(모달 대체 — dialog 없이 패널 인라인) ────────────────────────────

function confirmPanel(title, content, onConfirm) {
  return () => {
    const panel = el("div", { class: "panel", style: "border-color:var(--accent)" },
      el("h2", { text: title }),
      ...content,
      el("div", { class: "row end", style: "margin-top:10px" },
        el("button", { text: "취소", onClick: () => renderProject() }),
        el("button", {
          class: "primary", text: "확인",
          onClick: async () => { await onConfirm(); },
        }),
      ),
    );
    const main = document.querySelector("main");
    main.replaceChildren(panel);
    panel.scrollIntoView({ block: "center" });
  };
}

// ── 실시간 푸시 (SSE, 8.4/M4) ────────────────────────────────────────────────
// manifest 변경 '신호'만 받는다(데이터 없음) — 데이터 경로는 정적 파일로 유지.

let stream = null;

function openStream(projectId) {
  closeStream();
  try {
    stream = new EventSource(`/projects/${enc(projectId)}/events`);
    stream.addEventListener("manifest", async () => {
      await loadDelivery();
      state.releases = (await api("GET", `/projects/${enc(projectId)}/releases`)).releases;
      renderProject();
    });
    stream.onopen = () => { state.live = true; renderProject(); };
    stream.onerror = () => { state.live = false; };
  } catch { state.live = false; }
}

function closeStream() {
  if (stream) { stream.close(); stream = null; }
  state.live = false;
}

// ── 부팅 ─────────────────────────────────────────────────────────────────────

async function boot() {
  if (!state.token) return renderLogin();
  try {
    state.me = await api("GET", "/me");
    await openProjects();
  } catch (e) {
    logout();
    if (e.status !== 401) toast("error", "서버에 연결하지 못했습니다", String(e.message ?? e));
  }
}

boot();
