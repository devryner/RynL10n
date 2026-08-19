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
  conflict: "409 — 현재 상태와 충돌",
  forbidden: "403 — 권한 부족",
  not_found: "404 — 대상을 찾을 수 없음",
  bad_request: "400 — 요청이 올바르지 않음",
};

// ── 상태 ─────────────────────────────────────────────────────────────────────

/** 번역 그리드 필터의 초기값 — 프로젝트를 바꾸면 이 값으로 되돌린다. */
const emptyFilter = () => ({ q: "", locale: "", onlyMissing: false, state: "" });

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
  filter: emptyFilter(), // 번역 탭 검색·필터(클라이언트 측 — 키 목록은 이미 전부 받아온다)
  pendingImport: null,   // {fileName, data} — 파일을 고른 뒤 복원 전까지 들고 있는 export(9.2)
  users: [],             // 사용자 관리(7.3) — admin일 때만 채운다
  issuedToken: null,     // {userId, token} — 방금 발급한 토큰 평문. **이 화면이 유일한 노출**이다
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
  state.users = [];
  state.issuedToken = null; // 토큰 평문을 세션 밖까지 들고 있지 않는다
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
  // 사용자 관리(7.3)는 admin 전용 라우트라 다른 역할은 아예 부르지 않는다(403 소음 방지).
  if (can("admin")) state.users = (await api("GET", "/users")).users;
  renderProjects();
}

/**
 * 프로젝트 삭제 — 되돌릴 수 없다(DB + 산출물). 두 겹으로 막는다.
 *
 * ① 서버가 published 릴리스를 409로 거절한다(archive 우선). 산출물이 사라지면 현장의 SDK는
 *    manifest를 못 받고 구운 번들로 되돌아간다 — 2계층 resolve(3.1) 덕에 앱이 죽지는 않지만
 *    원격 갱신이 조용히 끊긴다.
 * ② UI는 프로젝트 ID를 그대로 타이핑해야 확인 버튼이 열린다. 목록에서 옆줄을 잘못 누르는 게
 *    실제 위험이라, 클릭 한 번으로 지워지면 안 된다.
 *
 * 실패해도 패널을 닫지 않는다 — 409(archive 먼저)는 사용자가 상황을 고치고 되돌아올 여지가 있다.
 */
function deleteProject(p) {
  const echo = el("input", { placeholder: p.id, class: "grow" });
  return confirmPanel(
    `${p.id} 삭제`,
    [
      el("p", {}, "이 프로젝트의 ",
        el("b", {}, "키 · 번역 · 릴리스 · 배포 산출물"), "이 모두 삭제됩니다. 되돌릴 수 없습니다."),
      el("p", { class: "small muted",
        text: "published 릴리스가 남아 있으면 서버가 막습니다 — 먼저 릴리스를 보관(archive)하세요." }),
      el("label", { class: "field grow" }, `확인하려면 프로젝트 ID "${p.id}" 를 입력하세요`, echo),
    ],
    async () => {
      const out = await run(null, () => api("DELETE", `/projects/${enc(p.id)}`));
      if (!out) return; // 실패는 run()이 토스트로 표면화 — 패널은 남겨 재시도할 수 있게 둔다
      const r = out.removed ?? {};
      toast("ok", `${p.id} 를 삭제했습니다`,
        `키 ${r.keys ?? 0} · 릴리스 ${r.releases ?? 0} · 로케일 ${r.locales ?? 0}`);
      await openProjects();
    },
    {
      onCancel: openProjects, // 상세가 아니라 목록으로 — 여기엔 state.project가 없다
      confirmLabel: "영구 삭제",
      confirmClass: "danger",
      arm: (btn) => {
        btn.disabled = true;
        echo.addEventListener("input", () => { btn.disabled = echo.value.trim() !== p.id; });
      },
    },
  );
}

/**
 * 프로젝트 import(9.2) — export의 반대편. `export`는 프로젝트 안(배포 탭)에 있지만 import는
 * **새 프로젝트를 만드는 작업**이라 목록 화면에 둔다(`POST /projects/import`도 프로젝트 스코프가 아니다).
 *
 * 파일을 고르는 즉시 보내지 않고 미리보기를 한 번 거친다. 이유가 둘이다:
 *   ① 엉뚱한 JSON을 골랐을 때 네트워크를 타기 전에 로컬에서 잡는다.
 *   ② 복원할 ID를 그 자리에서 바꿀 수 있다 — 서버가 덮어쓰기를 409로 막으므로(import는 병합이
 *      아니다), "다른 ID로 복사본 복원"이 사실상 기본 경로다. 실패해도 패널을 닫지 않는 건
 *      프로젝트 삭제와 같은 이유 — 사용자가 ID만 고쳐 바로 다시 시도할 수 있어야 한다.
 */
function importPanel() {
  const picker = el("input", { type: "file", accept: "application/json,.json" });

  picker.addEventListener("change", async () => {
    const file = picker.files?.[0];
    if (!file) return;
    let data;
    try { data = JSON.parse(await file.text()); } catch (e) {
      toast("error", "JSON을 읽지 못했습니다", String(e.message ?? e));
      return;
    }
    // 서버의 requireProjectExport와 같은 판정을 최소한으로 미리 한다 — 왕복을 아끼려는 것.
    if (!data?.project?.id || !Array.isArray(data.keys)) {
      toast("error", "export 파일이 아닙니다", "관리 API의 '전체 export'로 받은 JSON을 올려주세요.");
      return;
    }
    state.pendingImport = { fileName: file.name ?? "export.json", data };
    renderProjects();
  });

  if (!state.pendingImport) {
    return el("div", { class: "panel" },
      el("h2", {}, "프로젝트 가져오기",
        el("span", { class: "hint", text: "'전체 export'로 받은 JSON — 락인 없는 복원 경로(9.2)" })),
      el("div", { class: "row" },
        el("label", { class: "field grow" }, "export 파일", picker),
      ),
    );
  }

  const { fileName, data } = state.pendingImport;
  const idInput = el("input", { class: "grow", value: data.project.id });
  const counts = `로케일 ${(data.locales ?? []).length} · 키 ${data.keys.length} · 릴리스 ${(data.releases ?? []).length}`;

  const restore = async () => {
    const id = idInput.value.trim();
    if (!id) { toast("error", "복원할 프로젝트 ID는 필수입니다"); return; }
    const body = { ...data, project: { ...data.project, id } };
    const out = await run(null, () => api("POST", "/projects/import", body));
    if (!out) return; // 409(이미 있는 ID)·400은 run()이 토스트로 — 패널은 남겨 ID를 고칠 수 있게 둔다
    toast("ok", `${id} 를 복원했습니다`, counts);
    state.pendingImport = null;
    await openProjects();
  };

  return el("div", { class: "panel", style: "border-color:var(--accent)" },
    el("h2", {}, "가져오기 확인", el("span", { class: "hint", text: fileName })),
    el("p", { class: "small" },
      el("b", { text: data.project.name ?? "" }), ` — 기본 로케일 ${data.project.defaultLocale ?? "?"} · ${counts}`),
    el("p", { class: "small muted",
      text: "이미 있는 ID로는 복원할 수 없습니다(덮어쓰기 없음) — 복사본을 만들려면 ID를 바꾸세요." }),
    el("div", { class: "row" },
      el("label", { class: "field grow" }, "복원할 프로젝트 ID", idInput),
      el("button", { class: "primary", text: "복원", onClick: restore }),
      el("button", { text: "취소", onClick: () => { state.pendingImport = null; renderProjects(); } }),
    ),
  );
}

// ── 사용자 관리(7.3) — admin 전용, 인스턴스 수준(프로젝트 스코프 아님)이라 목록 화면에 둔다 ──

/**
 * 역할별 안내의 단일 원천(릴리스 폼의 MATCH_HINTS와 같은 패턴). 역할을 고르면 그 자리에서
 * "무엇을 할 수 있는지"가 바뀐다 — 조직 호칭(어드민·편집자·일반)과 시스템 역할 4종을 잇는 자리.
 */
const ROLE_HINTS = {
  viewer: "일반 — 읽기 전용(번역·릴리스·배포 열람만)",
  translator: "편집자(번역) — 번역 값·키 설명 편집까지",
  maintainer: "편집자(릴리스) — 번역 편집 + 릴리스 생성·publish·롤백",
  admin: "어드민 — 전부 + 프로젝트·사용자 관리",
};

async function reloadUsers() {
  state.users = (await api("GET", "/users")).users;
  renderProjects();
}

/** 방금 발급한 토큰 안내 — 평문은 DB에 없으므로(해시만) 이 패널을 닫으면 다시 볼 수 없다. */
function issuedTokenNotice() {
  const { userId, token } = state.issuedToken;
  const box = el("input", { value: token, readonly: true, class: "grow mono" });
  return el("div", { class: "panel", style: "border-color:var(--accent)" },
    el("h2", {}, `${userId} 의 새 토큰`, el("span", { class: "hint", text: "지금만 볼 수 있습니다 — 복사해 전달하세요" })),
    el("p", { class: "small muted", text: "서버에는 해시만 저장됩니다. 잃어버리면 폐기하고 다시 발급하세요." }),
    el("div", { class: "row" },
      box,
      el("button", { class: "tiny", text: "복사", onClick: () => globalThis.navigator?.clipboard?.writeText(token) }),
      el("button", { class: "tiny", text: "닫기", onClick: () => { state.issuedToken = null; renderProjects(); } }),
    ),
  );
}

function userRow(u) {
  // 역할 인라인 변경 — 실패(마지막 admin 409 등)하면 셀렉트를 원래 값으로 되돌린다.
  const roleSel = el("select", { "aria-label": `${u.id} 역할` },
    ...Object.keys(ROLE_HINTS).map((r) => el("option", { value: r, text: r, selected: u.role === r })));
  roleSel.value = u.role;
  roleSel.addEventListener("change", async () => {
    const ok = await run(`${u.id} 역할 → ${roleSel.value}`, () =>
      api("PATCH", `/users/${enc(u.id)}`, { role: roleSel.value }));
    if (ok) await reloadUsers();
    else roleSel.value = u.role;
  });

  const issue = async () => {
    const out = await run(null, () => api("POST", `/users/${enc(u.id)}/tokens`, { label: "" }));
    if (!out) return;
    state.issuedToken = { userId: u.id, token: out.token };
    await reloadUsers();
  };

  const revoke = (t) => async () => {
    const ok = await run("토큰을 폐기했습니다", () =>
      api("DELETE", `/users/${enc(u.id)}/tokens/${enc(t.id)}`));
    if (ok) await reloadUsers();
  };

  const toggle = async () => {
    const ok = await run(`${u.id} ${u.disabled ? "활성화" : "비활성"}`, () =>
      api("PATCH", `/users/${enc(u.id)}`, { disabled: !u.disabled }));
    if (ok) await reloadUsers();
  };

  const remove = () => {
    const echo = el("input", { placeholder: u.id, class: "grow" });
    confirmPanel(
      `${u.id} 삭제`,
      [
        el("p", {}, "이 사용자와 ", el("b", {}, "모든 토큰"), "이 즉시 폐기됩니다. 되돌릴 수 없습니다."),
        el("label", { class: "field grow" }, `확인하려면 사용자 ID "${u.id}" 를 입력하세요`, echo),
      ],
      async () => {
        const out = await run(null, () => api("DELETE", `/users/${enc(u.id)}`));
        if (!out) return; // 409(마지막 admin)는 패널을 남겨 다른 admin을 만들고 돌아올 수 있게 둔다
        toast("ok", `${u.id} 를 삭제했습니다`);
        await openProjects();
      },
      {
        onCancel: openProjects, // 목록 화면 — state.project가 없으므로 renderProject로 가면 안 된다
        confirmLabel: "영구 삭제",
        confirmClass: "danger",
        arm: (btn) => {
          btn.disabled = true;
          echo.addEventListener("input", () => { btn.disabled = echo.value.trim() !== u.id; });
        },
      },
    )();
  };

  return el("tr", {},
    el("td", { class: "mono" }, u.id,
      u.disabled ? el("div", {}, el("span", { class: "badge off", text: "비활성" })) : null),
    el("td", { text: u.name }),
    el("td", {}, roleSel),
    el("td", { class: "small mono", text: u.projects === "*" ? "전체" : u.projects.join(", ") }),
    el("td", { class: "small" },
      ...u.tokens.map((t) => el("div", { class: "row" },
        el("span", { class: "mono muted", text: t.label || t.id.slice(0, 8) }),
        el("button", { class: "tiny danger", text: "폐기", onClick: revoke(t) }),
      )),
      el("button", { class: "tiny", text: "토큰 발급", onClick: issue }),
    ),
    el("td", {}, el("div", { class: "row" },
      el("button", { class: "tiny", text: u.disabled ? "활성화" : "비활성", onClick: toggle }),
      el("button", { class: "tiny danger", text: "삭제", onClick: remove }),
    )),
  );
}

function usersPanel() {
  const idIn = el("input", { placeholder: "user-id", class: "grow" });
  const nameIn = el("input", { placeholder: "사용자 이름", class: "grow" });
  const hint = el("span", { class: "hint", text: ROLE_HINTS.viewer });
  const roleSel = el("select", { "aria-label": "역할" },
    ...Object.keys(ROLE_HINTS).map((r) => el("option", { value: r, text: r })));
  roleSel.value = "viewer"; // 최소 권한이 기본값
  roleSel.addEventListener("change", () => { hint.textContent = ROLE_HINTS[roleSel.value]; });

  const allBox = el("input", { type: "checkbox", "aria-label": "모든 프로젝트" });
  allBox.checked = true; // checked는 속성이 아니라 프로퍼티로 확정한다
  const scopeBox = el("select", {
    multiple: true, "aria-label": "접근 가능한 프로젝트",
    size: String(Math.min(6, Math.max(3, state.projects.length || 3))),
  }, ...state.projects.map((p) => el("option", { value: p.id, text: p.id })));
  scopeBox.disabled = true;
  allBox.addEventListener("change", () => { scopeBox.disabled = allBox.checked; });

  const create = async () => {
    const id = idIn.value.trim(), name = nameIn.value.trim();
    if (!id || !name) { toast("error", "id · 이름은 필수입니다"); return; }
    const projects = allBox.checked ? "*" : [...scopeBox.selectedOptions].map((o) => o.value);
    if (projects !== "*" && !projects.length) {
      toast("error", "프로젝트를 선택하거나 '모든 프로젝트'를 켜세요"); return;
    }
    const ok = await run("사용자를 만들었습니다", () =>
      api("POST", "/users", { id, name, role: roleSel.value, projects }));
    if (ok) { idIn.value = nameIn.value = ""; await reloadUsers(); }
  };

  return [
    state.issuedToken ? issuedTokenNotice() : null,
    el("div", { class: "panel" },
      el("h2", {}, "사용자", el("span", { class: "hint", text: "역할·프로젝트 스코프로 접근을 구분합니다 (7.3)" })),
      state.users.length
        ? el("div", { class: "tablewrap" }, el("table", {},
            el("thead", {}, el("tr", {},
              el("th", { text: "ID" }), el("th", { text: "이름" }), el("th", { text: "역할" }),
              el("th", { text: "프로젝트" }), el("th", { text: "토큰" }), el("th", { text: "작업" }),
            )),
            el("tbody", {}, ...state.users.map(userRow)),
          ))
        : el("p", { class: "muted", text: "아직 사용자가 없습니다. 아래에서 추가하세요 — 부트스트랩 env 토큰은 사용자를 만든 뒤 회전하세요." }),
      el("div", { class: "row", style: "margin-top:10px" },
        el("label", { class: "field grow" }, "사용자 ID", idIn),
        el("label", { class: "field grow" }, "이름", nameIn),
        el("label", { class: "field" }, "역할", roleSel),
      ),
      el("div", { class: "row", style: "margin-top:6px; align-items:flex-start" },
        el("label", { class: "row small muted" }, allBox, "모든 프로젝트(*)"),
        el("label", { class: "field grow" }, "프로젝트 선택 (다중)", scopeBox),
        el("button", { class: "primary", text: "사용자 추가", onClick: create }),
      ),
      hint,
    ),
  ];
}

function renderProjects() {
  const admin = can("admin");
  const rows = state.projects.map((p) =>
    el("tr", {},
      el("td", {}, el("button", { class: "link", text: p.id, onClick: () => openProject(p.id) })),
      el("td", { text: p.name }),
      el("td", { class: "mono", text: p.defaultLocale }),
      el("td", {}, admin
        ? el("button", { class: "tiny danger", text: "삭제", onClick: deleteProject(p) })
        : null),
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
            el("thead", {}, el("tr", {},
              el("th", { text: "ID" }), el("th", { text: "이름" }), el("th", { text: "기본 로케일" }),
              el("th", { text: admin ? "작업" : "" }),
            )),
            el("tbody", {}, ...rows),
          ))
        : el("p", { class: "muted", text: "아직 프로젝트가 없습니다." }),
    ),
    admin
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
    admin ? usersPanel() : null,
    admin ? importPanel() : null,
  );
}

// ── 프로젝트 상세 ────────────────────────────────────────────────────────────

async function openProject(id) {
  state.projectId = id;
  state.pendingImport = null;   // 목록을 떠나면 고른 파일도 버린다 — 돌아왔을 때 남아 있으면 유령이다
  state.issuedToken = null;     // 토큰 평문도 같은 규칙 — 화면을 떠나면 노출을 끝낸다
  state.filter = emptyFilter(); // 프로젝트마다 키·로케일이 다르므로 필터를 물고 넘어가지 않는다
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

/** 번역 값을 검색·표시용 문자열로 — 복수형은 CLDR 카테고리 맵이라 JSON 문자열로 본다. */
function valueText(t) {
  if (t === undefined) return "";
  return typeof t.value === "string" ? t.value : JSON.stringify(t.value);
}

/**
 * 검색어 정규화 — NFC로 맞춘 뒤 소문자화.
 * 저장 포맷이 NFC라(11.1) 조합형으로 입력된 검색어도 같은 키를 찾게 하려면 여기서도 NFC를 맞춰야 한다.
 */
const norm = (s) => String(s ?? "").normalize("NFC").toLowerCase();

/** 값이 비어 있으면 미번역 — 키가 아예 없는 경우와 빈 문자열을 같게 본다. */
const isMissing = (t) => t === undefined || t.value === "" || t.value === undefined;

/**
 * 키 한 줄이 현재 필터를 통과하는지.
 * 로케일 선택은 "미번역·상태 조건을 어느 로케일에 적용할지"만 좁힌다(열 자체는 계속 다 보여준다).
 */
function matchesFilter(key, f, locales) {
  const targets = f.locale ? [f.locale] : locales;
  if (f.onlyMissing && !targets.some((l) => isMissing(key.translations[l]))) return false;
  if (f.state && !targets.some((l) => key.translations[l]?.state === f.state)) return false;

  const q = norm(f.q).trim();
  if (!q) return true;
  // 키 이름·설명·모든 로케일 값을 한 번에 훑는다(번역문으로 키를 되찾는 게 실제 사용 패턴).
  if (norm(key.name).includes(q) || norm(key.description).includes(q)) return true;
  return locales.some((l) => norm(valueText(key.translations[l])).includes(q));
}

function keyRow(key, locales, editable) {
  return el("tr", {},
    el("td", { class: "key" }, key.name,
      key.isPlural ? el("div", {}, el("span", { class: "badge", text: "복수형" })) : null,
      key.signature ? el("div", { class: "small muted", text: `서명: ${key.signature}` }) : null,
    ),
    descriptionCell(key, editable),
    ...locales.map((l) => translationCell(key, l, editable)),
    el("td", { class: "small muted", text: `${key.refCount}개` }),
  );
}

function tabTranslations() {
  const locales = state.project.locales;
  const editable = can("edit_translation");
  const f = state.filter;

  const head = el("tr", {},
    el("th", { text: "키" }),
    el("th", {}, "설명", el("span", { class: "muted", text: " (번역자용)" })),
    ...locales.map((l) => el("th", {}, l, l === state.project.defaultLocale ? el("span", { class: "muted", text: " (기본)" }) : null)),
    el("th", { text: "릴리스" }),
  );

  const tbody = el("tbody");
  const count = el("span", { class: "hint" });

  /**
   * 필터 결과만 다시 그린다 — 전체 재렌더(renderProject)를 쓰면 입력 노드가 교체되면서
   * 한 글자마다 포커스가 날아간다. 그리드 본문만 갈아끼우는 이유가 이것이다.
   */
  function paint() {
    const shown = state.keys.filter((k) => matchesFilter(k, f, locales));
    count.textContent = shown.length === state.keys.length
      ? `${state.keys.length}개`
      : `${shown.length} / ${state.keys.length}개`;

    if (!shown.length) {
      tbody.replaceChildren(el("tr", {}, el("td", {
        colspan: String(locales.length + 3), class: "muted empty",
        text: state.keys.length ? "조건에 맞는 키가 없습니다." : "키가 없습니다. 위에서 추가하세요.",
      })));
      return;
    }
    tbody.replaceChildren(...shown.map((k) => keyRow(k, locales, editable)));
  }
  paint();

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
        el("span", { class: "hint", text: "값을 고치고 Enter 또는 포커스 아웃으로 저장합니다" }),
        count),
      filterBar(locales, paint),
      editable ? keyAdder() : null,
      el("div", { class: "tablewrap" }, el("table", {}, el("thead", {}, head), tbody)),
    ),
  ];
}

/**
 * 검색·필터 바. 상태는 state.filter에 두고 여기서는 갱신만 한다 —
 * 편집 후 refresh()로 전체가 재렌더돼도 필터가 유지돼야 하기 때문.
 */
function filterBar(locales, paint) {
  const f = state.filter;

  const q = el("input", {
    type: "search", class: "grow", value: f.q,
    placeholder: "검색 — 키 이름 · 설명 · 번역 값",
    "aria-label": "번역 검색",
  });
  q.addEventListener("input", () => { f.q = q.value; paint(); });
  // type=search의 네이티브 지우기(×)는 input을 쏘지만, Esc로도 즉시 비울 수 있게 한다.
  q.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { q.value = ""; f.q = ""; paint(); }
  });

  const locale = el("select", { "aria-label": "로케일" },
    el("option", { value: "", text: "모든 로케일" }),
    ...locales.map((l) => el("option", { value: l, text: l, selected: f.locale === l })),
  );
  locale.value = f.locale;
  locale.addEventListener("change", () => { f.locale = locale.value; paint(); });

  const st = el("select", { "aria-label": "상태" },
    el("option", { value: "", text: "모든 상태" }),
    el("option", { value: "draft", text: "draft" }),
    el("option", { value: "reviewed", text: "reviewed" }),
  );
  st.value = f.state;
  st.addEventListener("change", () => { f.state = st.value; paint(); });

  const missing = el("input", { type: "checkbox", "aria-label": "미번역만 보기", checked: f.onlyMissing });
  missing.checked = f.onlyMissing; // checked는 속성이 아니라 프로퍼티로 확정한다
  missing.addEventListener("change", () => { f.onlyMissing = missing.checked; paint(); });

  const reset = el("button", {
    class: "tiny", text: "초기화",
    onClick: () => {
      Object.assign(f, emptyFilter());
      q.value = ""; locale.value = ""; st.value = ""; missing.checked = false;
      paint();
    },
  });

  return el("div", { class: "row filters" },
    q, locale, st,
    el("label", { class: "row small muted" }, missing, "미번역만"),
    reset,
  );
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
  const raw = valueText(t);
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

/**
 * 전략별 매칭 값의 예시·설명(4.3). 전략마다 값 문법이 완전히 달라서 — semver 비교자 / 정수
 * 비교자 / 자유 라벨 — 안내를 하나로 뭉뚱그리면 어느 쪽에도 맞지 않는다. 전략을 고르면
 * 그 자리에서 예시가 바뀐다. 최종 판정은 서버가 하고(값 파싱까지), 여기서는 안내만 한다.
 */
const MATCH_HINTS = {
  "semver-range": { placeholder: ">=3.2.0 <3.3.0", hint: "명시적 하한·상한만 지원합니다 (^, ~, || 불가)" },
  "integer-range": { placeholder: ">=4200 <4300", hint: "빌드넘버 정수 비교자. 앱은 buildNumber를 넘겨야 매칭됩니다." },
  "exact-label": { placeholder: "web-stable", hint: "자유 라벨. 앱이 넘긴 releaseLabel과 완전히 같아야 합니다." },
};

function releaseCreator() {
  const name = el("input", { placeholder: "3.2.x", class: "grow" });
  const strategy = el("select", {},
    ...Object.keys(MATCH_HINTS).map((s) => el("option", { value: s, text: s })),
  );
  const value = el("input", { placeholder: MATCH_HINTS["semver-range"].placeholder, class: "grow" });
  const hint = el("span", { class: "hint", text: MATCH_HINTS["semver-range"].hint });
  strategy.addEventListener("change", () => {
    const h = MATCH_HINTS[strategy.value] ?? MATCH_HINTS["semver-range"];
    value.setAttribute("placeholder", h.placeholder);
    hint.textContent = h.hint;
  });
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
    el("h2", {}, "새 릴리스", hint),
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

/**
 * `onCancel` 기본값이 renderProject()인 것은 원래 호출부 둘이 프로젝트 상세(릴리스 탭)라서다.
 * 프로젝트 목록처럼 상세가 없는 화면에서 쓸 때는 반드시 넘겨야 한다 — 아니면 state.project가
 * null인 채로 상세를 그리려다 깨진다.
 *
 * `arm`은 확인 버튼을 넘겨주는 이음새다. 되돌릴 수 없는 작업이 "입력을 맞춰야 버튼이 열리는"
 * 잠금을 걸 수 있게 하되, 그 규칙은 호출부가 갖는다(패널은 계속 범용).
 */
function confirmPanel(title, content, onConfirm, opts = {}) {
  const { onCancel = renderProject, confirmLabel = "확인", confirmClass = "primary", arm = null } = opts;
  return () => {
    const go = el("button", {
      class: confirmClass, text: confirmLabel,
      onClick: async () => { await onConfirm(); },
    });
    arm?.(go);
    const panel = el("div", { class: "panel", style: "border-color:var(--accent)" },
      el("h2", { text: title }),
      ...content,
      el("div", { class: "row end", style: "margin-top:10px" },
        el("button", { text: "취소", onClick: () => onCancel() }),
        go,
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
