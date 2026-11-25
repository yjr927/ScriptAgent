(() => {
  "use strict";

  const state = {
    file: null,
    run: null,
    report: null,
    activeJob: null,
    jobTimer: null,
    toastTimer: null,
    characterEntries: [],
    selectedCharacterIndex: 0,
    relationshipEntries: [],
    map: null,
    recentRuns: [],
    mapStage: ""
  };
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
  }[char]));
  const firstClaim = (items, fallback = "待确认") => Array.isArray(items) && items.length ? items[0].claim || fallback : fallback;

  function scenePositionText(order, total = state.run?.scene_count || 1) {
    const index = Math.max(1, Number(order) || 1);
    if (total <= 1) return "全剧";
    if (index === 1) return "故事开场";
    if (index === total) return "故事结尾";
    const ratio = index / total;
    if (ratio <= .34) return "故事前段";
    if (ratio <= .67) return "故事中段";
    return "故事后段";
  }

  function sceneTextLabel(value) {
    const raw = String(value || "").trim();
    const match = raw.match(/^(S\d{4})/i);
    if (!match) return raw || "原文场景";
    const scene = (state.run?.scenes || []).find((item) => item.id === match[1]);
    if (!scene) return "原文场景";
    const heading = String(scene.heading || "").trim();
    const generic = !heading || /^片段\s*\d+|^场景\s*\d+|^开场资料$/i.test(heading);
    const label = generic ? scenePositionText(scene.order) : heading;
    return /-E\d+/i.test(raw) ? `${label} · 原文依据` : label;
  }

  function evidenceText(ids, separator = "、") {
    return [...new Set(ids || [])].map(sceneTextLabel).join(separator);
  }

  function sectionMarker(label) {
    const markers = {
      "一句话人物形象": "概览", "快速版看到哪里": "范围", "继续深度分析会补充": "深入",
      "角色的一句话定位": "定位", "外在给人的第一印象": "印象", "更深层的性格和需求": "性格",
      "最想得到的东西": "欲望", "最害怕发生的事情": "恐惧", "面对冲突时的习惯反应": "冲突",
      "面对亲密关系时的行为模式": "关系", "角色最明显的性格矛盾": "矛盾",
      "说话的节奏、措辞和情绪表达方式": "表达", "角色通常不会说什么、不会做什么": "边界",
      "角色在故事开始和后期发生的变化": "变化", "支撑每一条判断的剧情或台词依据": "依据",
      "目前还无法确认的内容": "待定", "目前能确认的叙事信息": "已知",
      "为什么现在不能继续判断": "原因", "暂时不能确认的部分": "未知", "需要编剧补充或确认的问题": "待定"
    };
    return markers[label] || "内容";
  }

  function relationshipText(relation) {
    const stage = String(relation?.current_stage || "").trim();
    if (stage && stage !== "待确认") return stage;
    const surface = readableClaim(firstClaim(relation?.surface_relation, "关系待确认"));
    return surface.replace(/[。！？!?]/g, "").slice(0, 8) || "关系待确认";
  }

  async function request(url, options = {}) {
    const response = await fetch(url, options);
    let data = {};
    try { data = await response.json(); } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
    return data;
  }

  function showToast(message, type = "error") {
    const toast = $("#toast");
    toast.textContent = message;
    toast.className = `toast show ${type}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.className = "toast"; }, 4200);
  }

  async function init() {
    bindUpload();
    bindAnalysis();
    bindTabs();
    try {
      const status = await request("/api/status");
      const host = $("#systemStatus");
      host.className = `system-status ${status.api_key_configured ? "ready" : "error"}`;
      host.innerHTML = `<span class="status-dot"></span><span>${status.api_key_configured ? "API 已连接 · 本机运行" : "尚未配置 API Key"}</span>`;
    } catch (error) {
      $("#systemStatus").className = "system-status error";
      const message = window.location.protocol === "file:"
        ? "请通过本机服务打开"
        : "本地服务连接失败";
      $("#systemStatus").innerHTML = `<span class="status-dot"></span><span>${message}</span>`;
    }
    await loadRecentRuns();
  }

  function bindUpload() {
    const input = $("#scriptFile");
    const dropzone = $("#dropzone");
    input.addEventListener("change", () => selectFile(input.files?.[0]));
    ["dragenter", "dragover"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((eventName) => dropzone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragging");
    }));
    dropzone.addEventListener("drop", (event) => selectFile(event.dataTransfer?.files?.[0]));
    $("#prepareButton").addEventListener("click", prepareScript);
  }

  function selectFile(file) {
    if (!file) return;
    const allowed = ["txt", "md", "fountain", "screenplay", "pdf", "docx"];
    const extension = file.name.split(".").pop().toLowerCase();
    if (!allowed.includes(extension)) {
      showToast("请选择 TXT、Markdown、Fountain、PDF 或 DOCX 剧本。", "error");
      return;
    }
    state.file = file;
    $("#fileLabel").textContent = file.name;
    $("#prepareButton").disabled = false;
  }

  async function prepareScript() {
    if (!state.file) return;
    const button = $("#prepareButton");
    button.disabled = true;
    button.querySelector("span:first-child").textContent = "正在上传到本机";
    const form = new FormData();
    form.append("script", state.file);
    form.append("previous_run_id", $("#previousRunSelect")?.value || "");
    let jobStarted = false;
    const resetButton = () => {
      button.disabled = !state.file;
      button.querySelector("span:first-child").textContent = "免费切分并预览";
    };
    try {
      const job = await request("/api/prepare", { method: "POST", body: form });
      jobStarted = true;
      showJob(job);
      pollJob(job.id, async (finished) => {
        resetButton();
        await loadRun(finished.run_id);
        await loadRecentRuns();
        $("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
        showToast("剧本已在本机完成切分，可以先检查场景。", "success");
      }, resetButton);
    } catch (error) {
      showToast(error.message);
      resetButton();
    } finally { if (!jobStarted) resetButton(); }
  }

  async function loadRecentRuns() {
    try {
      const data = await request("/api/runs");
      state.recentRuns = data.runs || [];
      const section = $("#recentSection");
      const host = $("#recentRuns");
      if (!data.runs?.length) { section.hidden = true; return; }
      $("#versionLink").hidden = false;
      $("#previousRunSelect").innerHTML = '<option value="">不是，建立新档案</option>' + data.runs.slice(0, 30).map((run) => `
        <option value="${escapeHtml(run.run_id)}">${escapeHtml(run.source_name)} · 第 ${Number(run.version_number || 1)} 版</option>`).join("");
      section.hidden = false;
      host.innerHTML = data.runs.slice(0, 6).map((run) => `
        <button class="recent-card" type="button" data-run-id="${escapeHtml(run.run_id)}">
          <strong>${escapeHtml(run.source_name)}</strong>
          <span>${run.scene_count} 场 · ${run.has_report ? "已有分析报告" : "等待分析"}</span>
        </button>`).join("");
      $$("[data-run-id]", host).forEach((button) => button.addEventListener("click", async () => {
        await loadRun(button.dataset.runId);
        $("#workspace").scrollIntoView({ behavior: "smooth" });
      }));
    } catch (_) { /* The new-project state is valid. */ }
  }

  async function loadRun(runId) {
    const run = await request(`/api/runs/${encodeURIComponent(runId)}`);
    state.run = run;
    $("#workspace").hidden = false;
    $("#projectName").textContent = run.source_name;
    $("#sceneCount").textContent = run.scene_count;
    $("#caseId").textContent = run.run_id.slice(-10).toUpperCase();
    $("#sceneMeta").textContent = `${run.scene_count} 个场景 / 本地完成`;
    $("#caseStatus").textContent = run.has_report ? "已有报告" : "已切分";
    renderScenes(run.scenes || []);
    $("#permissionCheck").checked = false;
    updateAnalysisButtons();
    $("#downloadMarkdown").href = `/api/runs/${encodeURIComponent(run.run_id)}/download/report.md`;
    $("#downloadJson").href = `/api/runs/${encodeURIComponent(run.run_id)}/download/report.json`;
    if (run.has_report) await loadReport();
    else {
      state.report = null;
      $("#results").hidden = true;
      setSteps("prepared");
    }
    if (run.active_job) {
      showJob(run.active_job);
      if (run.active_job.kind === "analyze") setSteps("analyzing");
      pollJob(run.active_job.id, async () => {
        await loadRun(run.run_id);
        showToast("后台任务已经完成。", "success");
      });
    }
  }

  function renderScenes(scenes) {
    $("#sceneList").innerHTML = scenes.length ? scenes.map((scene) => `
      <div class="scene-row">
        <span class="scene-number">场景</span>
        <strong title="${escapeHtml(scene.heading)}">${escapeHtml(sceneTextLabel(scene.id))}</strong>
        <small>原文第 ${scene.start_line}–${scene.end_line} 行<br>${scene.char_count.toLocaleString()} 字符</small>
      </div>`).join("") : '<div class="empty-state">没有识别到场景</div>';
  }

  function bindAnalysis() {
    $("#permissionCheck").addEventListener("change", updateAnalysisButtons);
    $("#testAnalyzeButton").addEventListener("click", () => startAnalysis("quick"));
    $("#fullAnalyzeButton").addEventListener("click", () => {
      if (!state.run) return;
      const approved = window.confirm(`将对《${state.run.source_name}》进行逐场深度取证，耗时和 API 费用都会高于快速概览。是否继续？`);
      if (approved) startAnalysis("deep");
    });
  }

  function updateAnalysisButtons() {
    const enabled = Boolean(state.run && $("#permissionCheck").checked && !state.activeJob);
    $("#testAnalyzeButton").disabled = !enabled;
    $("#fullAnalyzeButton").disabled = !enabled;
    if ($("#generateTikTokButton")) $("#generateTikTokButton").disabled = !enabled;
  }

  async function startAnalysis(mode) {
    if (!state.run) return;
    try {
      const job = await request("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: state.run.run_id,
          mode,
          permission_confirmed: $("#permissionCheck").checked
        })
      });
      setSteps("analyzing");
      showJob(job);
      pollJob(job.id, async () => {
        await loadRun(state.run.run_id);
        $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
        showToast(mode === "quick" ? "一分钟人物概览已经生成。" : "深度角色与关系报告已经生成。", "success");
      });
    } catch (error) { showToast(error.message); }
  }

  function showJob(job) {
    state.activeJob = job;
    updateAnalysisButtons();
    $("#jobPanel").hidden = false;
    $("#jobPanel").classList.remove("failed");
    $("#jobCode").textContent = job.kind === "prepare"
      ? "LOCAL PROCESS / 01"
      : (job.kind === "character" ? "CHARACTER DEEP DIVE / 03" : (job.kind === "tiktok" ? "TREND STUDIO / 05" : "AI PROCESS / 02"));
    updateJob(job);
  }

  function updateJob(job) {
    $("#jobMessage").textContent = job.message || "正在处理";
    $("#progressBar").style.width = `${job.progress || 0}%`;
    $("#progressNumber").textContent = `${job.progress || 0}%`;
    const elapsed = Math.max(0, Math.floor(Date.now() / 1000 - (job.started_at || Date.now() / 1000)));
    const waitingForModel = ["analyze", "character", "tiktok"].includes(job.kind) && job.status !== "complete" && job.status !== "failed";
    const quickOverview = (job.logs || []).some((line) => line.includes("一分钟快速概览") || line.includes("一句话人物形象"));
    $("#jobWaitHint").textContent = waitingForModel
      ? (quickOverview
          ? `已等待 ${formatElapsed(elapsed)} · 正在生成短版概览，目标在 1 分钟左右完成`
          : (job.kind === "tiktok"
              ? `已等待 ${formatElapsed(elapsed)} · 正在实时检索热点并生成三套可拍素材`
              : `已等待 ${formatElapsed(elapsed)} · 深度分析会逐场取证，已完成内容会自动缓存`))
      : "";
    $("#jobLogs").innerHTML = (job.logs || []).map((line) => `<p>${escapeHtml(line)}</p>`).join("");
    $("#jobPanel").classList.toggle("failed", job.status === "failed");
  }

  function formatElapsed(seconds) {
    if (seconds < 60) return `${seconds} 秒`;
    return `${Math.floor(seconds / 60)} 分 ${String(seconds % 60).padStart(2, "0")} 秒`;
  }

  function pollJob(jobId, onComplete, onFailed = null) {
    clearTimeout(state.jobTimer);
    const poll = async () => {
      try {
        const job = await request(`/api/jobs/${jobId}`);
        updateJob(job);
        if (job.status === "complete") { state.activeJob = null; updateAnalysisButtons(); await onComplete(job); return; }
        if (job.status === "failed") { state.activeJob = null; updateAnalysisButtons(); showToast(job.error || "处理失败"); if (onFailed) onFailed(job); return; }
        state.jobTimer = setTimeout(poll, 1300);
      } catch (error) {
        showToast(error.message);
      }
    };
    poll();
  }

  function setSteps(stage) {
    const analyze = $("#stepAnalyze");
    const synthesize = $("#stepSynthesize");
    const review = $("#stepReview");
    [analyze, synthesize, review].forEach((node) => node.classList.remove("active", "done"));
    if (stage === "analyzing") analyze.classList.add("active");
    if (stage === "preview") {
      analyze.classList.add("done");
      synthesize.classList.add("active");
    }
    if (stage === "report") {
      analyze.classList.add("done");
      synthesize.classList.add("done");
      review.classList.add("active");
    }
  }

  async function loadReport() {
    state.report = await request(`/api/runs/${encodeURIComponent(state.run.run_id)}/report`);
    renderReport(state.report);
    setSteps(state.report.meta?.analysis_depth === "quick_overview" ? "preview" : "report");
    $("#results").hidden = false;
    $("#caseStatus").textContent = state.report.meta?.analysis_depth === "quick_overview"
      ? "快速概览"
      : (state.report.meta?.partial_analysis ? "部分报告" : "深度报告");
  }

  function renderReport(report) {
    const characters = Object.entries(report.characters || {});
    const relationships = Object.entries(report.relationships || {});
    $("#characterBadge").textContent = characters.length;
    $("#relationshipBadge").textContent = relationships.length;
    $("#reviewBadge").textContent = (report.review_queue || []).length;
    $("#partialBanner").hidden = !report.meta?.partial_analysis;
    renderCharacters(characters);
    renderStoryProgress(report.story_progress || {});
    renderRelationships(relationships);
    renderTikTok(report.tiktok_content || null);
    renderKnowledge(report.knowledge_ledger || []);
    renderReview(report.review_queue || []);
  }

  function renderCharacters(characters) {
    const host = $("#charactersView");
    if (!characters.length) { host.innerHTML = '<div class="empty-state">没有识别到可建立档案的角色。</div>'; return; }
    state.characterEntries = characters;
    state.selectedCharacterIndex = Math.min(state.selectedCharacterIndex, characters.length - 1);
    drawCharacterFocus();
  }

  function drawCharacterFocus() {
    const host = $("#charactersView");
    const [name, card] = state.characterEntries[state.selectedCharacterIndex];
    const evidenceState = characterEvidenceState(card);
    const profileMode = card._meta?.profile_mode || (state.report?.meta?.analysis_depth === "preview" ? "preview" : "full");
    const isPreview = profileMode === "preview";
    const sections = evidenceState.limited
      ? limitedCharacterOutlineItems(card)
      : (isPreview ? quickCharacterOutlineItems(card) : characterOutlineItems(card));
    host.innerHTML = `
      <div class="character-dossier ${evidenceState.limited ? "evidence-limited" : ""}">
        <aside class="character-identity">
          <div class="identity-sticky">
            <p class="identity-kicker">CHARACTER / 人物档案</p>
            <div class="identity-portrait" aria-hidden="true">
              <div class="identity-head"></div><div class="identity-body"></div>
              <span>${escapeHtml(characterInitials(name))}</span>
            </div>
            <div class="identity-nameplate">
              <small>PRIMARY IDENTITY</small>
              <h3>${escapeHtml(name)}</h3>
              <em>${escapeHtml((card.aliases || []).join(" / ") || "暂无别名")}</em>
            </div>
            <p class="identity-positioning">“${escapeHtml(readableClaim(firstClaim(card.one_line_positioning), "角色的一句话定位"))}”</p>
            <div class="identity-status ${evidenceState.limited ? "limited" : ""}"><i></i><span>${evidenceState.limited ? "角色资料不足" : (isPreview ? "快速证据预览" : "AI 人物理解")}</span><small>${evidenceState.limited ? "暂不建立完整人设" : (isPreview ? "可按需深入分析" : "需编剧确认")}</small></div>
          </div>
        </aside>
        <section class="character-reading" aria-label="${escapeHtml(name)}完整角色卡">
          <header class="reading-head">
            <p>${evidenceState.limited ? "CHARACTER CARD AGENT / LIMITED EVIDENCE" : (isPreview ? "CHARACTER CARD AGENT / QUICK EVIDENCE PREVIEW" : "CHARACTER CARD AGENT / FULL PROFILE")}</p>
            <h3>${evidenceState.limited ? "这个角色目前能确认什么？" : (isPreview ? "用一句话先看懂这个角色" : "这个角色到底是什么样的人？")}</h3>
            <span>${evidenceState.limited ? `当前没有可定位的直接证据，因此不会为 ${escapeHtml(name)} 强行补全性格。` : (isPreview ? "这是全剧快速概览；点击深度分析后，再补充性格依据、关系变化和成长弧线。" : "以下内容按角色理解顺序完整展开；每条判断都应能回到原始剧本。")}</span>
          </header>
          ${evidenceState.limited ? `<div class="limited-notice"><strong>为什么没有完整角色卡？</strong><p>这个角色可能尚未直接出场，或目前只有他人转述。Agent 会保留已知线索，但不会把间接信息写成性格事实。</p></div>` : ""}
          ${isPreview && !evidenceState.limited ? `<div class="profile-upgrade"><div><strong>需要更深的人物理解？</strong><p>只为 ${escapeHtml(name)} 生成完整角色卡，其他角色不会消耗额度。</p></div><button type="button" id="deepAnalyzeCharacter">生成完整角色卡 <span>→</span></button></div>` : ""}
          <div class="character-outline-list">
            ${sections.map((section, index) => `
              <article class="outline-item ${section.tone || ""}">
                <div class="outline-index"><i></i><span>${escapeHtml(sectionMarker(section.label))}</span></div>
                <div class="outline-content">
                  <div class="outline-title"><h4>${escapeHtml(section.label)}</h4><small>${escapeHtml(section.english)}</small></div>
                  <div class="outline-claims">
                    ${section.rows.map((row) => `
                      <div class="outline-claim">
                        <div class="plain-claim"><span>简明结论</span><p>${escapeHtml(readableClaim(row.text, section.label))}</p></div>
                        <details class="claim-source">
                          <summary>查看完整判断${row.evidence?.length ? `与 ${row.evidence.length} 条依据` : ""}</summary>
                          <p>${escapeHtml(row.text)}</p>
                          ${row.note ? `<p class="claim-note"><strong>谨慎说明</strong>${escapeHtml(row.note)}</p>` : ""}
                          ${row.evidence?.length ? `<div class="claim-evidence"><span>原文依据</span>${row.evidence.map((id) => `<code title="${escapeHtml(id)}">${escapeHtml(sceneTextLabel(id))}</code>`).join("")}</div>` : '<div class="claim-evidence no-evidence"><span>尚无可定位依据</span></div>'}
                        </details>
                      </div>`).join("")}
                  </div>
                </div>
              </article>`).join("")}
          </div>
          <footer class="reading-foot"><span>AI GENERATED INTERPRETATION</span><p>没有充分证据的内容会标记为“待确认”，不自行补写。</p></footer>
        </section>
        <div class="character-switcher" aria-label="选择人物">
          <div class="switcher-label"><span>CHARACTER INDEX</span><small>点击姓名切换人物</small></div>
          <div class="character-name-list">
            ${state.characterEntries.map(([entryName], index) => `
              <button type="button" data-character-index="${index}" class="character-name-button ${index === state.selectedCharacterIndex ? "active" : ""}">
                <span class="mini-person">${escapeHtml(characterInitials(entryName))}</span>
                <strong>${escapeHtml(entryName)}</strong>
                <small>人物</small>
              </button>`).join("")}
          </div>
        </div>
      </div>`;
    $$("[data-character-index]", host).forEach((button) => button.addEventListener("click", () => {
      state.selectedCharacterIndex = Number(button.dataset.characterIndex);
      drawCharacterFocus();
      host.scrollIntoView({ behavior: "smooth", block: "start" });
    }));
    $("#deepAnalyzeCharacter", host)?.addEventListener("click", () => startCharacterAnalysis(name));
  }

  async function startCharacterAnalysis(characterName) {
    if (!state.run || state.activeJob) return;
    if (!$("#permissionCheck").checked) {
      showToast("请先在上方勾选剧本 API 分析授权确认。");
      $("#permissionCheck").scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    try {
      const runId = state.run.run_id;
      const job = await request("/api/analyze-character", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          run_id: runId,
          character_name: characterName,
          permission_confirmed: true
        })
      });
      showJob(job);
      pollJob(job.id, async () => {
        await loadRun(runId);
        const index = state.characterEntries.findIndex(([name]) => name === characterName);
        if (index >= 0) state.selectedCharacterIndex = index;
        drawCharacterFocus();
        $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
        showToast(`${characterName} 的完整角色卡已生成。`, "success");
      });
    } catch (error) { showToast(error.message); }
  }

  function quickCharacterOutlineItems(card) {
    const item = (card.one_line_positioning || [])[0] || {};
    const evidence = [...new Set(item.evidence_ids || [])];
    return [
      {
        label: "一句话人物形象",
        english: "ONE-LINE CHARACTER OVERVIEW",
        rows: [{
          text: item.claim || "人物形象待确认",
          note: item.notes || "快速概览结论，深度分析后再补充依据。",
          evidence
        }]
      },
      {
        label: "快速版看到哪里",
        english: "QUICK COVERAGE",
        rows: [{
          text: evidence.length ? `主要参考场景：${evidenceText(evidence)}` : "目前没有足够场景支持稳定判断。",
          evidence: []
        }],
        tone: "evidence-section"
      },
      {
        label: "继续深度分析会补充",
        english: "AVAILABLE IN DEEP ANALYSIS",
        rows: [{
          text: "深层需求、欲望与恐惧、冲突模式、关系变化、成长弧线和逐条原文依据。",
          evidence: []
        }],
        tone: "uncertain-section"
      }
    ];
  }

  function characterOutlineItems(card) {
    const assertion = (label, english, field) => ({
      label,
      english,
      rows: Array.isArray(field) && field.length
        ? field.map((item) => ({ text: item.claim || "待确认", note: item.notes || "", evidence: [...new Set(item.evidence_ids || [])] }))
        : [{ text: "目前证据不足，等待编剧确认。", evidence: [] }]
    });
    const base = [
      assertion("角色的一句话定位", "ONE-LINE POSITIONING", card.one_line_positioning),
      assertion("外在给人的第一印象", "FIRST IMPRESSION", card.first_impression),
      assertion("更深层的性格和需求", "DEEPER PERSONALITY & NEEDS", card.deeper_personality_and_needs),
      assertion("最想得到的东西", "MOST WANTED", card.most_wanted),
      assertion("最害怕发生的事情", "GREATEST FEARS", card.greatest_fears),
      assertion("面对冲突时的习惯反应", "CONFLICT PATTERN", card.conflict_pattern),
      assertion("面对亲密关系时的行为模式", "INTIMACY PATTERN", card.intimacy_pattern),
      assertion("角色最明显的性格矛盾", "CENTRAL CONTRADICTIONS", card.central_contradictions),
      assertion("说话的节奏、措辞和情绪表达方式", "SPEECH & EMOTIONAL EXPRESSION", card.speech_rhythm_wording_emotion),
      assertion("角色通常不会说什么、不会做什么", "WOULD NOT SAY OR DO", card.will_not_say_or_do)
    ];
    const arc = card.arc || {};
    const arcRows = [
      { text: `故事开始：${arc.starting_state || "待确认"}`, evidence: [] },
      ...(arc.stages || []).map((stage) => ({ text: `${stage.stage || "变化阶段"}：${stage.state || "待确认"}${stage.key_behavior ? `；关键行为：${stage.key_behavior}` : ""}${stage.change_status ? `（${stage.change_status}）` : ""}`, evidence: [...new Set(stage.evidence_ids || [])] })),
      ...(arc.turning_points || []).map((point) => ({ text: `转折点${point.scene_id ? `（${sceneTextLabel(point.scene_id)}）` : ""}：${point.trigger || "触发事件待确认"}${point.before || point.after ? `；${point.before || "待确认"} → ${point.after || "待确认"}` : ""}`, evidence: [...new Set(point.evidence_ids || [])] })),
      { text: `故事后期：${arc.ending_state || "待确认"}`, evidence: [] },
      { text: `总体变化：${arc.overall_change || "待确认"}`, evidence: [] }
    ];
    const personalityRows = [
      { text: card.personality_change_summary || "目前还不能确认性格画像发生稳定改变。", evidence: [] },
      ...(card.personality_changes || []).map((change) => ({
        text: `${change.dimension || "性格维度"}：${change.initial_state || "待确认"} → ${change.current_state || "待确认"}（${change.change_nature || "待观察"}）${change.trigger ? `；触发：${change.trigger}` : ""}`,
        evidence: [...new Set(change.evidence_ids || change.scene_ids || [])]
      })),
      ...(card.personality_watchlist || []).map((text) => ({ text: `待观察：${text}`, evidence: [] }))
    ];
    const evidenceRows = base.flatMap((section) => {
      const ids = [...new Set(section.rows.flatMap((row) => row.evidence || []))];
      return ids.length ? [{ text: `${section.label}：${evidenceText(ids)}`, evidence: [] }] : [];
    });
    const arcEvidence = [...new Set(arcRows.flatMap((row) => row.evidence || []))];
    if (arcEvidence.length) evidenceRows.push({ text: `角色变化：${evidenceText(arcEvidence)}`, evidence: [] });
    return [
      ...base,
      { label: "人物的性格画像有没有改变", english: "PERSONALITY CHANGE", rows: personalityRows },
      { label: "角色在故事开始和后期发生的变化", english: "CHARACTER ARC", rows: arcRows },
      { label: "支撑每一条判断的剧情或台词依据", english: "EVIDENCE INDEX", rows: evidenceRows.length ? evidenceRows : [{ text: "尚未提取到可定位的原文证据。", evidence: [] }], tone: "evidence-section" },
      { label: "目前还无法确认的内容", english: "UNCONFIRMED QUESTIONS", rows: (card.unconfirmed_questions || []).length ? card.unconfirmed_questions.map((text) => ({ text, evidence: [] })) : [{ text: "暂无待确认问题。", evidence: [] }], tone: "uncertain-section" }
    ];
  }

  function characterEvidenceState(card) {
    const assertionFields = [
      "one_line_positioning", "first_impression", "deeper_personality_and_needs", "most_wanted",
      "greatest_fears", "conflict_pattern", "intimacy_pattern", "central_contradictions",
      "speech_rhythm_wording_emotion", "will_not_say_or_do"
    ];
    const ids = assertionFields.flatMap((field) => (card[field] || []).flatMap((item) => item.evidence_ids || []));
    ids.push(...(card.arc?.stages || []).flatMap((item) => item.evidence_ids || []));
    ids.push(...(card.arc?.turning_points || []).flatMap((item) => item.evidence_ids || []));
    const evidenceCount = new Set(ids).size;
    return { evidenceCount, limited: evidenceCount === 0 };
  }

  function limitedCharacterOutlineItems(card) {
    const knownRows = [...(card.one_line_positioning || []), ...(card.first_impression || [])]
      .map((item) => ({ text: item.claim || "待确认", note: item.notes || "", evidence: [...new Set(item.evidence_ids || [])] }));
    const unknownAreas = ["深层性格与需求", "核心欲望与恐惧", "冲突反应", "亲密关系模式", "性格矛盾", "语言风格", "行为底线", "角色变化"];
    return [
      {
        label: "目前能确认的叙事信息",
        english: "WHAT WE CURRENTLY KNOW",
        rows: knownRows.length ? knownRows : [{ text: "目前只能确认这个名字被剧本提及。", evidence: [] }]
      },
      {
        label: "为什么现在不能继续判断",
        english: "WHY THE PROFILE STOPS HERE",
        rows: [
          { text: "角色卡中没有可定位到原剧本的直接证据。", evidence: [] },
          { text: "他人的转述和间接线索，不能自动变成这个角色的性格、动机或关系事实。", evidence: [] }
        ],
        tone: "evidence-section"
      },
      {
        label: "暂时不能确认的部分",
        english: "NOT ENOUGH EVIDENCE YET",
        rows: [{ text: unknownAreas.join("、"), evidence: [] }]
      },
      {
        label: "需要编剧补充或确认的问题",
        english: "QUESTIONS FOR THE WRITER",
        rows: (card.unconfirmed_questions || []).length
          ? card.unconfirmed_questions.map((text) => ({ text, evidence: [] }))
          : [{ text: "需要补充这个角色的直接出场、台词、行动或可验证的原文。", evidence: [] }],
        tone: "uncertain-section"
      }
    ];
  }

  function readableClaim(value, sectionLabel = "") {
    const original = String(value || "待确认").replace(/\s+/g, " ").trim();
    const pendingPrefix = /^待确认[：:]\s*/.test(original);
    const uncertain = !pendingPrefix && /(尚不明确|尚无法确定|尚不能确认|无法确定|不足以确认|不足以建立|目前无法确定|现有材料不足以确认|待确认)/.test(original);
    if (uncertain) {
      const uncertaintyLabels = {
        "更深层的性格和需求": "深层性格与需求",
        "最想得到的东西": "最想得到什么",
        "最害怕发生的事情": "最害怕什么",
        "面对冲突时的习惯反应": "稳定的冲突模式",
        "面对亲密关系时的行为模式": "稳定的亲密关系模式",
        "角色最明显的性格矛盾": "核心性格矛盾",
        "说话的节奏、措辞和情绪表达方式": "说话与情绪表达方式",
        "角色通常不会说什么、不会做什么": "不会说或做什么"
      };
      return `${uncertaintyLabels[sectionLabel] || sectionLabel || "这项信息"}：暂时无法确认。`;
    }
    let text = original
      .replace(/^待确认[：:]\s*/, "")
      .replace(/（S\d{4}[^）]*）/g, "")
      .replace(/^(一个)?在当前场景中/, "")
      .replace(/^(一个)?在本场中/, "")
      .replace(/^一个在/, "")
      .replace(/^目前材料将 /, "")
      .replace(/ 呈现为/, "：")
      .replace(/、通过/g, "，只通过")
      .replace(/^首先呈现的是/, "")
      .replace(/^当下不易被外界接触持续打断：/, "抗拒外界接触：")
      .replace(/^本场选择可理解为：/, "")
      .replace(/^本场可推测/, "")
      .replace(/外界呼唤与抱持均未让这一行为持续停止/g, "外界干预仍无法阻止")
      .replace(/这一行为/g, "它")
      .replace(/的角色(?=[；。]|$)/g, "")
      .replace(/；其行为原因仍未揭示/g, "，原因未知")
      .replace(/；但.+$/g, "")
      .replace(/；不足以.+$/g, "")
      .replace(/；不能.+$/g, "")
      .trim();
    const sentence = text.split(/。/).find((part) => part.trim()) || text;
    const clauses = sentence.split(/[；;]/).map((part) => part.trim()).filter(Boolean);
    text = clauses[0] || sentence;
    if (text.length > 52) {
      const commaParts = text.split(/[，,]/).map((part) => part.trim()).filter(Boolean);
      let compact = "";
      for (const part of commaParts) {
        if (compact && `${compact}，${part}`.length > 45) break;
        compact = compact ? `${compact}，${part}` : part;
      }
      text = compact || `${text.slice(0, 45)}…`;
    }
    text = text.replace(/[；，\s]+$/g, "");
    return /[。！？!?]$/.test(text) ? text : `${text}。`;
  }

  function characterInitials(name) {
    const clean = String(name || "?").trim();
    return clean.slice(0, 2).toUpperCase();
  }

  function renderStoryProgress(progress) {
    const host = $("#storyView");
    const stages = progress.stages || [];
    const comparisons = progress.stage_comparisons || [];
    const version = progress.version_comparison || {};
    host.innerHTML = `
      <div class="story-overview">
        <section class="story-score-card">
          <p class="micro">STORY PROGRESS</p>
          <strong>${escapeHtml(progress.overall_pace || "待确认")}</strong>
          <span>${Math.round(Number(progress.pace_score || 0))}<small>/100 节奏分</small></span>
          <p>${escapeHtml(progress.overall_progress || "完成深度分析后生成剧情进展。")}</p>
        </section>
        <section class="story-priority panel-lite">
          <p class="micro">EDITOR PRIORITIES</p><h3>最值得复查</h3>
          <ul>${(progress.priority_notes || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>暂无优先问题。</li>"}</ul>
        </section>
      </div>
      <div class="story-stage-grid">${stages.map((stage, index) => `
        <article class="story-stage-card">
          <div class="stage-number">${String(index + 1).padStart(2, "0")}</div>
          <p class="micro">${escapeHtml(stage.start_scene || "")} — ${escapeHtml(stage.end_scene || "")}</p>
          <h3>${escapeHtml(stage.stage || "剧情阶段")}</h3>
          <p>${escapeHtml(stage.progress_summary || "待确认")}</p>
          <div class="stage-tags"><span>${escapeHtml(stage.conflict_phase || "待确认")}</span><span>${escapeHtml(stage.pace || "待确认")}</span></div>
          <dl><dt>节奏判断</dt><dd>${escapeHtml(stage.pace_reason || "待确认")}</dd><dt>完成的叙事任务</dt><dd>${escapeHtml((stage.narrative_tasks_completed || []).join("；") || "待确认")}</dd><dt>重复或停滞</dt><dd>${escapeHtml((stage.repetition_or_stall || []).join("；") || "未发现明确问题")}</dd><dt>长期未推进</dt><dd>${escapeHtml((stage.inactive_character_or_relationship_lines || []).join("；") || "未发现明确停滞线")}</dd></dl>
        </article>`).join("") || '<div class="empty-state">深度分析后会显示剧情阶段与节奏。</div>'}</div>
      <section class="comparison-block">
        <div class="panel-head"><div><p class="micro">STAGE COMPARISON</p><h3>前后阶段发生了什么</h3></div></div>
        <div class="comparison-grid">${comparisons.map((item) => `
          <article><h4>${escapeHtml(item.from_stage || "上一阶段")} → ${escapeHtml(item.to_stage || "当前阶段")}</h4>
          ${comparisonLine("剧情", item.plot_changes)}${comparisonLine("人物", item.character_state_changes)}${comparisonLine("关系", item.relationship_changes)}${comparisonLine("伏笔", item.foreshadowing_changes)}${comparisonLine("冲突", item.conflict_changes)}${comparisonLine("信息差", item.information_gap_changes)}
          <small>${escapeHtml(evidenceText(item.evidence_scene_ids || [], " · "))}</small></article>`).join("") || '<div class="empty-state">当前没有足够阶段用于前后对比。</div>'}</div>
      </section>
      <section class="version-comparison panel-lite">
        <p class="micro">VERSION COMPARISON</p><h3>${version.has_previous_version ? `与《${escapeHtml(version.previous_source_name || "上一版本")}》对比` : "尚未关联上一版本"}</h3>
        <p>${escapeHtml(version.notes || "上传新版本时可选择上一份档案，深度分析后自动比较。")}</p>
        ${version.has_previous_version ? `<div class="version-columns">${comparisonList("新增或加强", version.added_or_expanded)}${comparisonList("删除或弱化", version.removed_or_weakened)}${comparisonList("实质改动", version.materially_changed)}${comparisonList("人物变化", version.character_changes)}${comparisonList("关系变化", version.relationship_changes)}${comparisonList("节奏变化", version.pace_changes)}</div>` : ""}
      </section>`;
  }

  function comparisonLine(label, items) {
    return `<p><strong>${label}</strong>${escapeHtml((items || []).join("；") || "无明确变化")}</p>`;
  }

  function comparisonList(title, items) {
    return `<div><h4>${escapeHtml(title)}</h4><ul>${(items || []).map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>无明确变化</li>"}</ul></div>`;
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(String(value || ""));
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch (_) { return ""; }
  }

  function renderTikTok(content) {
    const host = $("#tiktokView");
    const saved = content?.settings || {};
    const names = Object.keys(state.report?.characters || {});
    const sources = content?._web_sources || [];
    host.innerHTML = `
      <div class="tiktok-studio">
        <section class="tiktok-controls">
          <p class="micro">TREND STORY STUDIO</p><h3>把当前剧情变成可拍的 TikTok 素材</h3>
          <p>生成时会实时检索热点。热点结果会显示来源和生成时间，但不会自动发布。</p>
          <div class="form-grid">
            <label><span>目标市场</span><input id="tiktokMarket" value="${escapeHtml(saved.market || "北美 TikTok")}"></label>
            <label><span>视频长度</span><select id="tiktokDuration">${[15, 30, 60].map((v) => `<option value="${v}" ${Number(saved.duration_seconds || 30) === v ? "selected" : ""}>${v} 秒</option>`).join("")}</select></label>
            <label><span>剧透程度</span><select id="tiktokSpoiler">${["无剧透", "轻微剧透", "强钩子"].map((v) => `<option ${saved.spoiler_level === v ? "selected" : ""}>${v}</option>`).join("")}</select></label>
            <label><span>目标观众</span><input id="tiktokAudience" value="${escapeHtml(saved.audience || "喜欢人物关系与短剧内容的观众")}"></label>
            <label><span>情绪方向</span><input id="tiktokEmotion" value="${escapeHtml(saved.emotional_direction || "暧昧张力与关系反转")}"></label>
            <label><span>更新频率</span><input id="tiktokFrequency" value="${escapeHtml(saved.update_frequency || "按当前制作进度灵活发布")}"></label>
            <label><span>下一次更新日期</span><input id="tiktokDate" type="date" value="${escapeHtml(saved.next_update_date || "")}"></label>
          </div>
          <fieldset><legend>优先使用角色（不选则自动判断）</legend><div class="character-checks">${names.map((name) => `<label><input type="checkbox" data-tiktok-character value="${escapeHtml(name)}" ${(saved.selected_characters || []).includes(name) ? "checked" : ""}><span>${escapeHtml(name)}</span></label>`).join("")}</div></fieldset>
          <label class="adult-confirm"><input type="checkbox" id="adultCharactersConfirmed" ${saved.adult_characters_confirmed ? "checked" : ""}><span>我确认用于暧昧版本的角色均为成年人；未确认时，大胆版只使用冲突和悬念。</span></label>
          <button class="primary-button full-button" id="generateTikTokButton" type="button" ${state.activeJob ? "disabled" : ""}><span>${content ? "重新检索热点并生成" : "检索热点并生成三套素材"}</span><span>→</span></button>
          <p class="cost-note">需要勾选上方的数据权限确认。每次点击都会进行新的网页检索并调用模型。</p>
        </section>
        <section class="tiktok-output">
          ${content ? renderTikTokOutput(content, sources) : '<div class="empty-state"><strong>等待生成</strong><br>将得到安全传播版、大胆暧昧版和争议讨论版。</div>'}
        </section>
      </div>`;
    $("#generateTikTokButton")?.addEventListener("click", startTikTokGeneration);
  }

  function renderTikTokOutput(content, sources) {
    return `
      <div class="trend-summary"><p class="micro">LIVE TREND SNAPSHOT</p><h3>热点匹配</h3><p>${escapeHtml(content.trend_summary || "")}</p><small>生成时间：${escapeHtml(content.generated_at || "")}</small><a class="text-button" href="/api/runs/${encodeURIComponent(state.run?.run_id || "")}/download/tiktok-content.json">下载完整素材 JSON</a></div>
      <div class="trend-list">${(content.trends || []).map((trend) => {
        const url = safeHttpUrl(trend.source_url);
        return `<article><span>${escapeHtml(trend.heat_stage || "无法确认")}</span><h4>${escapeHtml(trend.trend_name || "热点")}</h4><p>${escapeHtml(trend.why_it_fits || "")}</p>${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(trend.source_title || "查看来源")}</a>` : ""}</article>`;
      }).join("")}</div>
      <div class="concept-stack">${(content.concepts || []).map((concept) => `
        <article class="concept-card risk-${escapeHtml(concept.risk_level || "低")}">
          <div class="concept-head"><span>${escapeHtml(concept.intensity || "")}</span><span>风险 ${escapeHtml(concept.risk_level || "待确认")}</span></div>
          <h3>${escapeHtml(concept.title || "短视频创意")}</h3><p class="concept-lede">${escapeHtml(concept.one_line_story || "")}</p>
          <dl><dt>前三秒</dt><dd>${escapeHtml(concept.hook_first_3_seconds || "")}</dd><dt>热点结合</dt><dd>${escapeHtml(concept.trend_connection || "")}</dd><dt>封面</dt><dd>${escapeHtml(concept.cover_title || "")}</dd><dt>文案</dt><dd>${escapeHtml(concept.caption || "")}</dd><dt>标签</dt><dd>${escapeHtml((concept.hashtags || []).join(" "))}</dd><dt>评论互动</dt><dd>${escapeHtml(concept.comment_prompt || "")}</dd><dt>发布时间</dt><dd>${escapeHtml(concept.publish_timing || "")}</dd></dl>
          <details><summary>${Number(concept.duration_seconds || 30)} 秒完整脚本与分镜</summary><div class="shot-list">${(concept.script || []).map((shot) => `<div><strong>${escapeHtml(shot.timecode || "")}</strong><p>${escapeHtml(shot.visual || "")}</p><p><b>台词/旁白：</b>${escapeHtml(shot.dialogue_or_voiceover || "")}</p><small>${escapeHtml(shot.on_screen_text || "")}</small></div>`).join("")}</div></details>
          <div class="concept-scores"><span>热点 ${Math.round(Number(concept.trend_match_score || 0))}</span><span>传播 ${Math.round(Number(concept.viral_potential_score || 0))}</span><span>${escapeHtml(evidenceText(concept.source_scene_ids || [], " · "))}</span></div>
        </article>`).join("")}</div>
      ${sources.length ? `<div class="source-list"><h4>本次网页检索来源</h4>${sources.map((source) => { const url = safeHttpUrl(source.url); return url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${escapeHtml(source.title || source.url)}</a>` : ""; }).join("")}</div>` : ""}`;
  }

  async function startTikTokGeneration() {
    if (!state.run) return;
    if (!$("#permissionCheck").checked) {
      showToast("请先确认你有权将这份剧本提交给模型和网页检索工具。");
      return;
    }
    const settings = {
      market: $("#tiktokMarket").value,
      duration_seconds: Number($("#tiktokDuration").value),
      spoiler_level: $("#tiktokSpoiler").value,
      audience: $("#tiktokAudience").value,
      emotional_direction: $("#tiktokEmotion").value,
      update_frequency: $("#tiktokFrequency").value,
      next_update_date: $("#tiktokDate").value,
      selected_characters: $$('[data-tiktok-character]:checked').map((item) => item.value),
      adult_characters_confirmed: $("#adultCharactersConfirmed").checked
    };
    try {
      const job = await request("/api/generate-tiktok", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ run_id: state.run.run_id, permission_confirmed: true, settings })
      });
      showJob(job);
      pollJob(job.id, async () => {
        await loadRun(state.run.run_id);
        $('button[data-tab="tiktok"]')?.click();
        $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
        showToast("三套 TikTok 素材和热点来源已经生成。", "success");
      });
    } catch (error) { showToast(error.message); }
  }

  function renderRelationships(relationships) {
    const host = $("#relationshipsView");
    state.relationshipEntries = relationships;
    const stageOptions = [...new Set(relationships.flatMap(([, relation]) => (relation.graph_stages || []).map((stage) => stage.stage).filter(Boolean)))];
    if (state.mapStage && !stageOptions.includes(state.mapStage)) state.mapStage = "";
    host.innerHTML = `
      <div class="mindmap-shell">
        <section class="mindmap-board">
          <div class="mindmap-toolbar">
            <div><span>RELATIONSHIP FOCUS MAP</span><small>点击人物重排 · 点击关系名称查看详情</small></div>
            <div class="map-controls">
              <select id="relationStageSelect" aria-label="选择关系阶段"><option value="">当前状态</option>${stageOptions.map((stage) => `<option ${state.mapStage === stage ? "selected" : ""}>${escapeHtml(stage)}</option>`).join("")}</select>
              <button type="button" data-map-action="out" aria-label="缩小">−</button>
              <button type="button" data-map-action="reset">居中</button>
              <button type="button" data-map-action="in" aria-label="放大">＋</button>
            </div>
          </div>
          <canvas id="relationshipCanvas" aria-label="可交互的人物关系思维导图"></canvas>
          <div class="map-legend"><span><i class="legend-focus"></i>当前中心人物</span><span><i class="legend-character"></i>直接相关人物</span><span><i class="legend-relation"></i>关系状态</span></div>
          <div class="map-character-index">${Object.keys(state.report?.characters || {}).map((name) => `<button type="button" data-map-character="${escapeHtml(name)}">${escapeHtml(name)}</button>`).join("")}</div>
        </section>
        <aside class="map-detail" id="mapDetail">
          <p class="micro">HOW TO READ</p>
          <h3>人物关系思维导图</h3>
          <p>图中一次只展示一个中心人物及其直接关系，避免线条交叉。点击其他人物即可重新聚焦。</p>
          <div class="map-empty-mark">＋</div>
        </aside>
      </div>`;
    setupMindMap();
  }

  function renderKnowledge(items) {
    $("#knowledgeView").innerHTML = items.length ? `<div class="knowledge-list">${items.map((item) => `
      <div class="knowledge-item"><code title="${escapeHtml(item.scene_id)}">${escapeHtml(sceneTextLabel(item.scene_id))}</code><p>${escapeHtml(item.fact)}</p><small>${escapeHtml(item.audience_status)}<br>已知：${escapeHtml((item.known_by || []).join("、") || "未记录")}<br>未知：${escapeHtml((item.not_known_by || []).join("、") || "未记录")}</small></div>`).join("")}</div>` : '<div class="empty-state">暂无信息差记录。</div>';
  }

  function renderReview(items) {
    const storageKey = `idore-review-${state.report?.meta?.source_digest || "draft"}`;
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(storageKey) || "{}"); } catch (_) { saved = {}; }
    const host = $("#reviewView");
    host.innerHTML = `<div class="review-toolbar"><span>共 ${items.length} 条判断需要人工确认</span><button class="text-button" id="exportReview" type="button">导出审核结果</button></div>
      <div>${items.map((item, index) => `
        <div class="review-row">
          <div class="review-owner">${escapeHtml(item.owner_type)}<br>${escapeHtml(item.owner)}</div>
          <div class="review-claim"><strong>${escapeHtml(item.claim)}</strong><small>${escapeHtml(evidenceText(item.evidence_ids || [], " · ") || "无直接证据")}</small></div>
          <div class="review-controls">
            <select data-review-decision="${index}" aria-label="审核结论">${["待确认", "人物理解", "正式设定", "驳回"].map((choice) => `<option ${((saved[index]?.decision || item.suggested_status) === choice) ? "selected" : ""}>${choice}</option>`).join("")}</select>
            <input data-review-note="${index}" aria-label="编剧备注" placeholder="编剧备注" value="${escapeHtml(saved[index]?.notes || "")}">
          </div>
        </div>`).join("")}</div>`;
    const save = () => {
      const output = {};
      items.forEach((item, index) => {
        output[index] = {
          owner: item.owner,
          claim: item.claim,
          evidence_ids: item.evidence_ids,
          decision: $(`[data-review-decision="${index}"]`, host)?.value || "",
          notes: $(`[data-review-note="${index}"]`, host)?.value || ""
        };
      });
      localStorage.setItem(storageKey, JSON.stringify(output));
      return output;
    };
    host.addEventListener("change", save);
    host.addEventListener("input", save);
    $("#exportReview", host)?.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(save(), null, 2)], { type: "application/json" });
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "editor-review.json";
      link.click();
      URL.revokeObjectURL(link.href);
    });
  }

  function bindTabs() {
    $("#resultTabs").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-tab]");
      if (!button) return;
      $$("button[data-tab]", $("#resultTabs")).forEach((item) => item.classList.toggle("active", item === button));
      const views = {
        characters: "#charactersView", story: "#storyView", relationships: "#relationshipsView",
        tiktok: "#tiktokView", knowledge: "#knowledgeView", review: "#reviewView"
      };
      Object.entries(views).forEach(([name, selector]) => { $(selector).hidden = name !== button.dataset.tab; });
      if (button.dataset.tab === "relationships") window.setTimeout(() => resizeMindMap(true), 30);
    });
    window.addEventListener("resize", () => {
      if (state.map && !$("#relationshipsView").hidden) resizeMindMap(false);
    });
  }

  function setupMindMap() {
    const canvas = $("#relationshipCanvas");
    if (!canvas) return;
    const names = Object.keys(state.report?.characters || {});
    const degree = Object.fromEntries(names.map((name) => [name, 0]));
    state.relationshipEntries.forEach(([, relation]) => {
      if (relation.person_a in degree) degree[relation.person_a] += 1;
      if (relation.person_b in degree) degree[relation.person_b] += 1;
    });
    const initialFocus = [...names].sort((a, b) => degree[b] - degree[a] || a.localeCompare(b))[0] || "";
    state.map = {
      canvas,
      context: canvas.getContext("2d"),
      allNames: names,
      focusName: initialFocus,
      nodes: [],
      nodeLookup: {},
      edges: [],
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      ratio: 1,
      width: 0,
      height: 0,
      dragging: false,
      moved: false,
      dragStartX: 0,
      dragStartY: 0,
      startOffsetX: 0,
      startOffsetY: 0,
      hitEdges: [],
      selection: null
    };
    focusMindMapCharacter(initialFocus, false);
    bindMindMapInteractions();
    $$("[data-map-character]", $("#relationshipsView")).forEach((button) => button.addEventListener("click", () => {
      focusMindMapCharacter(button.dataset.mapCharacter, true);
    }));
    $$("[data-map-action]", $("#relationshipsView")).forEach((button) => button.addEventListener("click", () => {
      if (button.dataset.mapAction === "reset") resizeMindMap(true);
      else zoomMindMap(button.dataset.mapAction === "in" ? 1.18 : .84);
    }));
    $("#relationStageSelect")?.addEventListener("change", (event) => {
      state.mapStage = event.target.value;
      focusMindMapCharacter(state.map?.focusName || initialFocus, false);
    });
    resizeMindMap(true);
  }

  function relationshipStageSnapshot(relation) {
    const stages = relation?.graph_stages || [];
    if (!state.mapStage) return stages[stages.length - 1] || null;
    return stages.find((stage) => stage.stage === state.mapStage) || null;
  }

  function focusMindMapCharacter(name, resetView = true) {
    const map = state.map;
    if (!map || !name) return;
    const related = state.relationshipEntries.filter(([, relation]) => relation.person_a === name || relation.person_b === name);
    const center = { id: name, type: "focus", label: name, x: 0, y: 0, width: 196, height: 76 };
    const nodes = [center];
    const edges = [];
    const count = Math.max(1, related.length);
    related.forEach(([key, relation], index) => {
      const otherName = relation.person_a === name ? relation.person_b : relation.person_a;
      const angle = -Math.PI / 2 + (Math.PI * 2 * index / count);
      const snapshot = relationshipStageSnapshot(relation);
      const node = {
        id: otherName,
        type: "character",
        label: otherName,
        x: Math.cos(angle) * 360,
        y: Math.sin(angle) * 235,
        width: 176,
        height: 66
      };
      nodes.push(node);
      edges.push({
        id: key,
        index,
        label: snapshot?.relation_label || relationshipText(relation),
        strength: Number(snapshot?.strength ?? relation.relationship_strength ?? .5),
        direction: snapshot?.direction || relation.relationship_direction || "不明确",
        changeStatus: snapshot?.change_status || "待确认",
        snapshot,
        relation,
        start: center,
        end: node
      });
    });
    map.focusName = name;
    map.nodes = nodes;
    map.nodeLookup = Object.fromEntries(nodes.map((node) => [node.id, node]));
    map.edges = edges;
    map.selection = { type: "character", id: name };
    $$("[data-map-character]", $("#relationshipsView")).forEach((button) => button.classList.toggle("active", button.dataset.mapCharacter === name));
    showMapCharacter(name);
    if (resetView && map.width) fitMindMap();
    drawMindMap();
  }

  function resizeMindMap(resetPosition) {
    const map = state.map;
    if (!map) return;
    const box = map.canvas.getBoundingClientRect();
    if (box.width < 20 || box.height < 20) return;
    map.ratio = Math.min(2, window.devicePixelRatio || 1);
    map.width = box.width;
    map.height = box.height;
    map.canvas.width = Math.floor(box.width * map.ratio);
    map.canvas.height = Math.floor(box.height * map.ratio);
    if (resetPosition || !map.offsetX) fitMindMap();
    drawMindMap();
  }

  function fitMindMap() {
    const map = state.map;
    if (!map) return;
    const xs = map.nodes.map((node) => [node.x - node.width / 2, node.x + node.width / 2]).flat();
    const ys = map.nodes.map((node) => [node.y - node.height / 2, node.y + node.height / 2]).flat();
    const worldWidth = Math.max(...xs) - Math.min(...xs) + 160;
    const worldHeight = Math.max(...ys) - Math.min(...ys) + 160;
    map.scale = Math.max(.42, Math.min(1.1, map.width / worldWidth, map.height / worldHeight));
    map.offsetX = map.width / 2;
    map.offsetY = map.height / 2;
  }

  function drawMindMap() {
    const map = state.map;
    if (!map || !map.width) return;
    const context = map.context;
    context.setTransform(map.ratio, 0, 0, map.ratio, 0, 0);
    context.clearRect(0, 0, map.width, map.height);
    context.fillStyle = "#f8f5ff";
    context.fillRect(0, 0, map.width, map.height);
    context.strokeStyle = "#e4dcf4";
    context.lineWidth = 1;
    const grid = 44;
    const gridX = ((map.offsetX % (grid * map.scale)) + grid * map.scale) % (grid * map.scale);
    const gridY = ((map.offsetY % (grid * map.scale)) + grid * map.scale) % (grid * map.scale);
    for (let x = gridX; x < map.width; x += grid * map.scale) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, map.height); context.stroke(); }
    for (let y = gridY; y < map.height; y += grid * map.scale) { context.beginPath(); context.moveTo(0, y); context.lineTo(map.width, y); context.stroke(); }

    context.save();
    context.translate(map.offsetX, map.offsetY);
    context.scale(map.scale, map.scale);

    map.hitEdges = [];
    map.edges.forEach((edge) => {
      const start = edge.start, end = edge.end;
      const selected = map.selection?.type === "relationship" && map.selection.id === edge.id;
      const colors = { "新增": "#7045d6", "升级": "#1f8a68", "弱化": "#b37a18", "破裂": "#b74747", "稳定": "#7e6b9f", "待确认": "#aa91da" };
      const edgeColor = selected ? "#4b2f67" : (colors[edge.changeStatus] || "#aa91da");
      context.strokeStyle = edgeColor;
      context.lineWidth = (selected ? 4.5 : 1.5 + Math.max(0, Math.min(1, edge.strength)) * 4) / map.scale;
      context.beginPath();
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
      context.stroke();
      drawRelationshipArrows(context, edge, edgeColor);
      const midX = start.x + (end.x - start.x) * .58;
      const midY = start.y + (end.y - start.y) * .58;
      const label = edge.label;
      context.font = "700 12px 'Avenir Next', sans-serif";
      const labelWidth = Math.max(58, Math.min(136, context.measureText(label).width + 26));
      context.fillStyle = selected ? "#7045d6" : "#f1ebff";
      context.strokeStyle = selected ? "#4b2f67" : "#9a7bd2";
      context.lineWidth = 1.5 / map.scale;
      roundedRectPath(context, midX - labelWidth / 2, midY - 14, labelWidth, 28, 14);
      context.fill(); context.stroke();
      context.fillStyle = selected ? "#fff" : "#55336f";
      context.textAlign = "center"; context.textBaseline = "middle";
      context.fillText(trimCanvasText(context, label, labelWidth - 18), midX, midY + .5);
      map.hitEdges.push({ edge, x: midX - labelWidth / 2, y: midY - 14, width: labelWidth, height: 28 });
    });

    map.nodes.forEach((node) => drawMapNode(context, node, map));
    context.restore();
  }

  function drawRelationshipArrows(context, edge, color) {
    const direction = edge.direction;
    if (!direction || direction === "不明确") return;
    const relation = edge.relation || {};
    const fromA = relation.person_a === state.map?.focusName;
    const points = [];
    if (direction === "双向") points.push([edge.start, edge.end], [edge.end, edge.start]);
    else if (direction === "A→B") points.push(fromA ? [edge.start, edge.end] : [edge.end, edge.start]);
    else if (direction === "B→A") points.push(fromA ? [edge.end, edge.start] : [edge.start, edge.end]);
    points.forEach(([from, to]) => {
      const dx = to.x - from.x, dy = to.y - from.y;
      const length = Math.max(1, Math.hypot(dx, dy));
      const ux = dx / length, uy = dy / length;
      const tipX = to.x - ux * 44, tipY = to.y - uy * 34;
      context.fillStyle = color;
      context.beginPath();
      context.moveTo(tipX, tipY);
      context.lineTo(tipX - ux * 13 - uy * 7, tipY - uy * 13 + ux * 7);
      context.lineTo(tipX - ux * 13 + uy * 7, tipY - uy * 13 - ux * 7);
      context.closePath();
      context.fill();
    });
  }

  function drawMapNode(context, node, map) {
    const selected = map.selection?.type === "character" && map.selection.id === node.id;
    if (node.type === "focus") {
      context.fillStyle = "#7045d6";
      context.strokeStyle = "#4b2f67";
    } else {
      context.fillStyle = selected ? "#ffffff" : "#f2edff";
      context.strokeStyle = selected ? "#7045d6" : "#aa98c3";
    }
    context.lineWidth = (selected ? 4 : 2) / map.scale;
    roundedRectPath(context, node.x - node.width / 2, node.y - node.height / 2, node.width, node.height, 7);
    context.fill(); context.stroke();
    context.textAlign = "center"; context.textBaseline = "middle";
    if (node.type === "focus") {
      context.fillStyle = "#fff"; context.font = "800 12px sans-serif";
      context.fillText(trimCanvasText(context, node.label, 160), node.x, node.y - 7);
      context.fillStyle = "#eadfff"; context.font = "9px monospace";
      context.fillText("当前中心人物", node.x, node.y + 15);
    } else {
      context.fillStyle = "#151515"; context.font = "800 15px sans-serif";
      context.fillText(trimCanvasText(context, node.label, 145), node.x, node.y - 7);
      context.fillStyle = "#765895"; context.font = "9px monospace";
      context.fillText("CHARACTER NODE", node.x, node.y + 15);
    }
  }

  function roundedRectPath(context, x, y, width, height, radius) {
    const r = Math.min(radius, width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.lineTo(x + width - r, y); context.quadraticCurveTo(x + width, y, x + width, y + r);
    context.lineTo(x + width, y + height - r); context.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
    context.lineTo(x + r, y + height); context.quadraticCurveTo(x, y + height, x, y + height - r);
    context.lineTo(x, y + r); context.quadraticCurveTo(x, y, x + r, y);
    context.closePath();
  }

  function trimCanvasText(context, text, maxWidth) {
    const value = String(text || "");
    if (context.measureText(value).width <= maxWidth) return value;
    let output = value;
    while (output.length > 2 && context.measureText(`${output}…`).width > maxWidth) output = output.slice(0, -1);
    return `${output}…`;
  }

  function bindMindMapInteractions() {
    const map = state.map;
    const canvas = map.canvas;
    canvas.addEventListener("pointerdown", (event) => {
      map.dragging = true; map.moved = false;
      map.dragStartX = event.clientX; map.dragStartY = event.clientY;
      map.startOffsetX = map.offsetX; map.startOffsetY = map.offsetY;
      canvas.setPointerCapture(event.pointerId);
      canvas.classList.add("dragging");
    });
    canvas.addEventListener("pointermove", (event) => {
      if (!map.dragging) return;
      const dx = event.clientX - map.dragStartX, dy = event.clientY - map.dragStartY;
      if (Math.abs(dx) + Math.abs(dy) > 4) map.moved = true;
      map.offsetX = map.startOffsetX + dx; map.offsetY = map.startOffsetY + dy;
      drawMindMap();
    });
    canvas.addEventListener("pointerup", (event) => {
      map.dragging = false; canvas.classList.remove("dragging");
      if (!map.moved) selectMindMapItem(event);
    });
    canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const box = canvas.getBoundingClientRect();
      zoomMindMap(event.deltaY < 0 ? 1.1 : .9, event.clientX - box.left, event.clientY - box.top);
    }, { passive: false });
  }

  function zoomMindMap(multiplier, anchorX = null, anchorY = null) {
    const map = state.map;
    if (!map) return;
    const x = anchorX ?? map.width / 2, y = anchorY ?? map.height / 2;
    const worldX = (x - map.offsetX) / map.scale, worldY = (y - map.offsetY) / map.scale;
    map.scale = Math.max(.35, Math.min(2.1, map.scale * multiplier));
    map.offsetX = x - worldX * map.scale; map.offsetY = y - worldY * map.scale;
    drawMindMap();
  }

  function selectMindMapItem(event) {
    const map = state.map;
    const box = map.canvas.getBoundingClientRect();
    const worldX = (event.clientX - box.left - map.offsetX) / map.scale;
    const worldY = (event.clientY - box.top - map.offsetY) / map.scale;
    const node = [...map.nodes].reverse().find((item) =>
      worldX >= item.x - item.width / 2 && worldX <= item.x + item.width / 2 &&
      worldY >= item.y - item.height / 2 && worldY <= item.y + item.height / 2
    );
    if (node) {
      focusMindMapCharacter(node.id, node.id !== map.focusName);
    } else {
      const hit = map.hitEdges.find((item) => worldX >= item.x && worldX <= item.x + item.width && worldY >= item.y && worldY <= item.y + item.height);
      if (hit) {
        map.selection = { type: "relationship", id: hit.edge.id };
        showMapRelationship(hit.edge.id, hit.edge.relation);
      }
    }
    drawMindMap();
  }

  function showMapCharacter(name) {
    const card = state.report?.characters?.[name] || {};
    $("#mapDetail").innerHTML = `
      <p class="micro">CHARACTER NODE</p><span class="map-detail-index">人物</span><h3>${escapeHtml(name)}</h3>
      <p class="map-detail-lede">${escapeHtml(firstClaim(card.one_line_positioning))}</p>
      <dl><dt>深层需求</dt><dd>${escapeHtml(firstClaim(card.deeper_personality_and_needs))}</dd><dt>核心矛盾</dt><dd>${escapeHtml(firstClaim(card.central_contradictions))}</dd><dt>总体变化</dt><dd>${escapeHtml(card.arc?.overall_change || "待确认")}</dd></dl>`;
  }

  function showMapRelationship(key, relation) {
    const snapshot = relationshipStageSnapshot(relation);
    $("#mapDetail").innerHTML = `
      <p class="micro">RELATIONSHIP EDGE</p><span class="map-detail-index">${escapeHtml(snapshot?.stage || relation.current_stage || "待确认")}</span><h3>${escapeHtml(key)}</h3>
      <p class="map-detail-lede">${escapeHtml(firstClaim(relation.underlying_state))}</p>
      <dl><dt>关系类型</dt><dd>${escapeHtml(relation.relationship_type || "待确认")}</dd><dt>阶段强度与方向</dt><dd>${Math.round(Number(snapshot?.strength ?? relation.relationship_strength ?? 0) * 100)}% · ${escapeHtml(snapshot?.direction || relation.relationship_direction || "不明确")}</dd><dt>最近变化</dt><dd>${escapeHtml(snapshot?.latest_change || "待确认")}</dd><dt>表面关系</dt><dd>${escapeHtml(firstClaim(relation.surface_relation))}</dd><dt>${escapeHtml(relation.person_a)} 如何理解对方</dt><dd>${escapeHtml(firstClaim(relation.a_view_of_b))}</dd><dt>${escapeHtml(relation.person_b)} 如何理解对方</dt><dd>${escapeHtml(firstClaim(relation.b_view_of_a))}</dd><dt>当前冲突</dt><dd>${escapeHtml(firstClaim(relation.current_conflict))}</dd></dl>
      <div class="map-timeline"><strong>关系突破</strong>${(relation.breakthroughs || []).map((item) => `<p><i></i><span>${escapeHtml(sceneTextLabel(item.scene_id))} · ${escapeHtml(item.breakthrough_type)}</span>${escapeHtml(item.before || "待确认")} → ${escapeHtml(item.after || "待确认")}<small>${escapeHtml(item.significance || "")}</small></p>`).join("") || '<p><i></i>暂无确认突破</p>'}</div>
      <div class="map-timeline"><strong>完整变化线</strong>${(relation.timeline || []).map((item) => `<p><i></i><span>${escapeHtml(item.stage)}</span>${escapeHtml(item.state)}</p>`).join("") || '<p><i></i>暂无确认变化</p>'}</div>`;
  }

  init();
})();
