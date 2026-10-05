/**
 * 日語極限默寫教練（龍櫻法 × 回音法）
 * 核心應用程式邏輯
 */

// =============================================================================
// 全域狀態 (State Management)
// =============================================================================

const APP_STATE = {
  currentCard: SAMPLE_CARDS[0], // 預設載入第 1 篇範例
  snowballCards: [],
  speech: {
    synth: window.speechSynthesis,
    voices: [],
    selectedVoice: "edge:ja-JP-NanamiNeural", // 預設採用高音質微軟神經女聲 (清晰大聲)
    rate: 1.0,
    pitch: 1.0,
    volumeBoost: "+100%", // 預設 +100% 大音量增益
    pauseDuration: 2.5, // 句子間回音停頓秒數
    isPlaying: false,
    currentSentenceIndex: 0,
    sentences: [],
    echoCount: 0,
    pauseTimeoutId: null,
    currentAudio: null
  },
  settings: {
    geminiKey: localStorage.getItem("echo_gemini_key") || "",
    geminiModel: getValidGeminiModel(),
    theme: localStorage.getItem("echo_theme") || "dark"
  },
  mediaRecorder: null,
  audioChunks: []
};

function getValidGeminiModel() {
  let m = localStorage.getItem("echo_gemini_model");
  if (!m || m.includes("2.0") || m.includes("2.5") || m === "gemini-2.0-flash" || m === "gemini-2.5-flash") {
    m = "gemini-3.8-flash";
    localStorage.setItem("echo_gemini_model", "gemini-3.8-flash");
  }
  return m;
}

// =============================================================================
// 初始化 (Initialization)
// =============================================================================

document.addEventListener("DOMContentLoaded", () => {
  initTheme();
  initSnowballCards();
  initSpeechSynthesis();
  initEventListeners();
  renderCurrentCard(APP_STATE.currentCard);
});

// =============================================================================
// 主題切換 (Theme Toggle)
// =============================================================================

function initTheme() {
  const savedTheme = APP_STATE.settings.theme;
  document.documentElement.setAttribute("data-theme", savedTheme);
  updateThemeButtonUI(savedTheme);
}

function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme") || "dark";
  const next = current === "dark" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", next);
  APP_STATE.settings.theme = next;
  localStorage.setItem("echo_theme", next);
  updateThemeButtonUI(next);
}

function updateThemeButtonUI(theme) {
  const icon = document.getElementById("theme-icon");
  const text = document.getElementById("theme-text");
  if (theme === "light") {
    icon.textContent = "☀️";
    text.textContent = "淺色";
  } else {
    icon.textContent = "🌙";
    text.textContent = "深色";
  }
}

// =============================================================================
// 語音合成引擎 (雙模引擎：微軟神經大音量語音 + 本機 Web Speech API)
// =============================================================================

function initSpeechSynthesis() {
  const select = document.getElementById("voice-select");
  if (!select) return;

  const populateVoiceList = () => {
    const previousVal = select.value || APP_STATE.speech.selectedVoice || "edge:ja-JP-NanamiNeural";
    select.innerHTML = "";

    // 1. 微軟高品質神經語音（支援音量增益，大聲且自然）
    const edgeGroup = document.createElement("optgroup");
    edgeGroup.label = "🌟 微軟極致高音質神經語音 (大音量增益 · 推薦)";

    const optNanami = document.createElement("option");
    optNanami.value = "edge:ja-JP-NanamiNeural";
    optNanami.textContent = "🌸 微軟 Nanami (東京女聲 · 清晰宏亮 · 預設推薦)";
    edgeGroup.appendChild(optNanami);

    const optKeita = document.createElement("option");
    optKeita.value = "edge:ja-JP-KeitaNeural";
    optKeita.textContent = "🌸 微軟 Keita (東京男聲 · 沉穩宏亮)";
    edgeGroup.appendChild(optKeita);

    select.appendChild(edgeGroup);

    // 2. 本機瀏覽器語音 (Web Speech API)
    if ("speechSynthesis" in window) {
      const allVoices = APP_STATE.speech.synth.getVoices();
      const jaVoices = allVoices.filter(v => v.lang.startsWith("ja") || v.lang.includes("JP"));
      APP_STATE.speech.voices = jaVoices;

      if (jaVoices.length > 0) {
        const localGroup = document.createElement("optgroup");
        localGroup.label = "💻 電腦本機瀏覽器語音 (受限於系統預設音量)";

        jaVoices.forEach((v, idx) => {
          const opt = document.createElement("option");
          opt.value = `local:${idx}`;
          opt.textContent = `${v.name} (${v.lang})`;
          localGroup.appendChild(opt);
        });
        select.appendChild(localGroup);
      }
    }

    // 保持先前的選取或預設
    select.value = previousVal;
    APP_STATE.speech.selectedVoice = select.value || "edge:ja-JP-NanamiNeural";
  };

  populateVoiceList();

  if ("speechSynthesis" in window && speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoiceList;
  }

  // 監聽使用者變更發音引擎
  select.addEventListener("change", (e) => {
    APP_STATE.speech.selectedVoice = e.target.value;
    updateDirectAudioLink();
  });
}

// 分割短文為自然句子
function splitIntoSentences(text) {
  if (!text) return [];
  // 按照日語句點「。」、「！」、「？」切分，保留標點
  const matches = text.match(/[^。！？]+[。！？]?/g);
  return matches ? matches.map(s => s.trim()).filter(s => s.length > 0) : [text];
}

// 播放單段語音（支援 Edge-TTS 高音量增益與本機 Web Speech API）
function speakText(text, onEnd) {
  if (!text) {
    if (onEnd) onEnd();
    return;
  }

  // 停止當前正在播出的任何音訊
  stopCurrentPlaybackOnly();

  const selected = APP_STATE.speech.selectedVoice || "edge:ja-JP-NanamiNeural";

  // 模式 A：使用微軟神經大音量語音（推薦）
  if (selected.startsWith("edge:")) {
    const voiceName = selected.replace("edge:", "");
    const volume = APP_STATE.speech.volumeBoost || "+100%";

    let rateParam = "+0%";
    if (APP_STATE.speech.rate <= 0.85) rateParam = "-20%";
    else if (APP_STATE.speech.rate >= 1.15) rateParam = "+20%";

    const url = `/api/tts?text=${encodeURIComponent(text)}&voice=${encodeURIComponent(voiceName)}&volume=${encodeURIComponent(volume)}&rate=${encodeURIComponent(rateParam)}`;

    const audio = new Audio(url);
    APP_STATE.speech.currentAudio = audio;
    setWaveformActive(true);

    let ended = false;
    const finish = () => {
      if (ended) return;
      ended = true;
      setWaveformActive(false);
      APP_STATE.speech.currentAudio = null;
      if (onEnd) onEnd();
    };

    audio.onended = finish;
    audio.onerror = (err) => {
      console.warn("Edge-TTS 音訊連線異常，自動切換為本機瀏覽器語音:", err);
      finish();
      speakWithLocalSynthesis(text, onEnd);
    };

    audio.play().catch(e => {
      console.warn("瀏覽器自動播放限制或音訊失敗，切換為本機語音:", e);
      finish();
      speakWithLocalSynthesis(text, onEnd);
    });
    return;
  }

  // 模式 B：使用本機瀏覽器語音
  speakWithLocalSynthesis(text, onEnd);
}

function speakWithLocalSynthesis(text, onEnd) {
  if (!("speechSynthesis" in window)) {
    if (onEnd) onEnd();
    return;
  }

  APP_STATE.speech.synth.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "ja-JP";
  utterance.rate = APP_STATE.speech.rate;
  utterance.pitch = APP_STATE.speech.pitch;
  utterance.volume = 1.0; // 強制拉滿瀏覽器音量至 100%

  if (APP_STATE.speech.selectedVoice && APP_STATE.speech.selectedVoice.startsWith("local:")) {
    const idx = parseInt(APP_STATE.speech.selectedVoice.replace("local:", ""), 10);
    if (APP_STATE.speech.voices[idx]) {
      utterance.voice = APP_STATE.speech.voices[idx];
    }
  }

  utterance.onstart = () => {
    setWaveformActive(true);
  };

  utterance.onend = () => {
    setWaveformActive(false);
    if (onEnd) onEnd();
  };

  utterance.onerror = (e) => {
    console.error("SpeechSynthesis error:", e);
    setWaveformActive(false);
    if (onEnd) onEnd();
  };

  APP_STATE.speech.synth.speak(utterance);
}

function stopCurrentPlaybackOnly() {
  if (APP_STATE.speech.currentAudio) {
    APP_STATE.speech.currentAudio.pause();
    APP_STATE.speech.currentAudio.currentTime = 0;
    APP_STATE.speech.currentAudio = null;
  }
  if ("speechSynthesis" in window) {
    APP_STATE.speech.synth.cancel();
  }
  setWaveformActive(false);
}

// 回音訓練：逐句循環播放與心理留白
function startEchoPlayback() {
  const card = APP_STATE.currentCard;
  if (!card || !card.bodyText) return;

  APP_STATE.speech.sentences = splitIntoSentences(card.bodyText);
  APP_STATE.speech.currentSentenceIndex = 0;
  APP_STATE.speech.isPlaying = true;

  updatePlayButtonUI(true);
  playNextEchoSentence();
}

function playNextEchoSentence() {
  if (!APP_STATE.speech.isPlaying) return;

  const sentences = APP_STATE.speech.sentences;
  const index = APP_STATE.speech.currentSentenceIndex;

  if (index >= sentences.length) {
    // 整篇讀完一次，朗讀計數加一
    APP_STATE.speech.echoCount++;
    updateEchoCountUI();
    
    // 短暫休息後開始下一輪
    const statusText = document.getElementById("echo-player-status");
    statusText.textContent = `第 ${APP_STATE.speech.echoCount} 遍完成！稍候即將進行下一遍...`;
    
    APP_STATE.speech.currentSentenceIndex = 0;
    APP_STATE.speech.pauseTimeoutId = setTimeout(() => {
      if (APP_STATE.speech.isPlaying) {
        playNextEchoSentence();
      }
    }, 2000);
    return;
  }

  const currentSentence = sentences[index];
  highlightEchoSentence(index);

  const statusText = document.getElementById("echo-player-status");
  statusText.textContent = `朗讀中（第 ${index + 1}/${sentences.length} 句）: "${currentSentence}"`;

  speakText(currentSentence, () => {
    if (!APP_STATE.speech.isPlaying) return;

    const pauseSec = APP_STATE.speech.pauseDuration;
    if (pauseSec > 0) {
      statusText.innerHTML = `🧠 <strong>回音留白 (${pauseSec}秒)</strong>：請在腦中重播剛才的母語發音...`;
      APP_STATE.speech.pauseTimeoutId = setTimeout(() => {
        if (APP_STATE.speech.isPlaying) {
          APP_STATE.speech.currentSentenceIndex++;
          playNextEchoSentence();
        }
      }, pauseSec * 1000);
    } else {
      APP_STATE.speech.currentSentenceIndex++;
      playNextEchoSentence();
    }
  });
}

function stopEchoPlayback() {
  APP_STATE.speech.isPlaying = false;
  if (APP_STATE.speech.pauseTimeoutId) {
    clearTimeout(APP_STATE.speech.pauseTimeoutId);
    APP_STATE.speech.pauseTimeoutId = null;
  }
  stopCurrentPlaybackOnly();
  updatePlayButtonUI(false);
  clearEchoSentenceHighlights();
  document.getElementById("echo-player-status").textContent = "已暫停，隨時可繼續播放";
}

function setWaveformActive(isActive) {
  const wave = document.getElementById("audio-waveform");
  if (isActive) {
    wave.classList.add("playing");
  } else {
    wave.classList.remove("playing");
  }
}

function updatePlayButtonUI(isPlaying) {
  const btn = document.getElementById("btn-main-play");
  btn.textContent = isPlaying ? "⏸️" : "▶️";
  btn.title = isPlaying ? "暫停" : "播放回音跟讀";
}

function updateEchoCountUI() {
  const countEl = document.getElementById("echo-current-count");
  const count = APP_STATE.speech.echoCount;
  countEl.textContent = count;

  if (count >= 5) {
    countEl.style.color = "var(--accent-matcha)";
  }
}

// =============================================================================
// 卡片渲染與狀態同步 (Card Rendering)
// =============================================================================

function renderCurrentCard(card) {
  if (!card) return;
  APP_STATE.currentCard = card;

  // 1. 母體短文
  const bodyTextEl = document.getElementById("card-body-text");
  bodyTextEl.textContent = card.bodyText;

  // 字數統計與合規判定 (50~80字)
  const length = card.bodyText.length;
  const counterBadge = document.getElementById("body-char-counter");
  counterBadge.textContent = `${length} 字 (${length >= 50 && length <= 80 ? "合格" : "需微調"})`;
  if (length >= 50 && length <= 80) {
    counterBadge.className = "char-counter-badge valid";
  } else {
    counterBadge.className = "char-counter-badge";
  }

  // 2. 漢字讀音指引卡片
  const kanjiGrid = document.getElementById("card-kanji-guide");
  kanjiGrid.innerHTML = "";
  if (Array.isArray(card.kanjiList)) {
    card.kanjiList.forEach(item => {
      const chip = document.createElement("div");
      chip.className = "kanji-chip";
      chip.title = "點擊單獨聽發音";
      chip.innerHTML = `
        <span class="chip-kanji">${escapeHtml(item.kanji)}</span>
        <span class="chip-kana">${escapeHtml(item.kana)}</span>
        ${item.note ? `<span class="chip-note">${escapeHtml(item.note)}</span>` : ""}
      `;
      chip.addEventListener("click", () => {
        speakText(item.kanji);
      });
      kanjiGrid.appendChild(chip);
    });
  }

  // 3. 中文原意對照
  document.getElementById("card-chinese-text").textContent = card.chineseTranslation || "";

  // 4. 白紙審判重點
  const particles = card.trialPoints?.particles || "注意格助詞（が/を/に/で）精確度";
  const conjugations = card.trialPoints?.conjugations || "注意動詞中頓形與使役/授受變化";
  document.getElementById("card-trial-particles").textContent = particles;
  document.getElementById("card-trial-conjugations").textContent = conjugations;

  // 5. 同步至 STEP 2 回音清單
  renderEchoSentences(card.bodyText);

  // 6. 同步至 A4 列印頁面
  syncToPrintSheet(card);

  // 7. 同步手機端直接收聽連結
  updateDirectAudioLink();
}

function renderEchoSentences(text) {
  const listEl = document.getElementById("sentence-echo-list");
  listEl.innerHTML = "";

  const sentences = splitIntoSentences(text);
  sentences.forEach((s, idx) => {
    const item = document.createElement("div");
    item.className = "sentence-echo-item";
    item.id = `echo-item-${idx}`;
    item.innerHTML = `
      <div style="display: flex; align-items: baseline; gap: 10px;">
        <span style="font-size: 11px; font-weight: 700; color: var(--accent-sakura);">${idx + 1}.</span>
        <span class="sentence-text">${escapeHtml(s)}</span>
      </div>
      <button class="sentence-btn-play" title="單句循環朗讀">▶</button>
    `;

    const playBtn = item.querySelector(".sentence-btn-play");
    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      clearEchoSentenceHighlights();
      item.classList.add("speaking");
      speakText(s, () => {
        item.classList.remove("speaking");
      });
    });

    listEl.appendChild(item);
  });
}

function highlightEchoSentence(index) {
  clearEchoSentenceHighlights();
  const el = document.getElementById(`echo-item-${index}`);
  if (el) {
    el.classList.add("speaking");
    el.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function clearEchoSentenceHighlights() {
  document.querySelectorAll(".sentence-echo-item").forEach(el => el.classList.remove("speaking"));
}

// 同步 A4 列印頁 (精準 2 頁式試卷排版)
function syncToPrintSheet(card) {
  if (!card) return;

  // 1. 漢字讀音指引
  const kanjiArea = document.getElementById("print-kanji-list");
  if (kanjiArea) {
    kanjiArea.innerHTML = "";
    if (Array.isArray(card.kanjiList)) {
      card.kanjiList.forEach(k => {
        const item = document.createElement("div");
        item.className = "print-kanji-item";
        item.innerHTML = `<strong>${escapeHtml(k.kanji)}</strong><span class="print-kana">（${escapeHtml(k.kana)}）</span>${k.note ? `<span style="font-size:7pt; color:#666;">[${escapeHtml(k.note)}]</span>` : ""}`;
        kanjiArea.appendChild(item);
      });
    }
  }

  // 2. 中文原意提示
  const chText = document.getElementById("print-chinese-text");
  if (chText) chText.textContent = card.chineseTranslation || "";

  // 3. 審判重點
  const trialPointsEl = document.getElementById("print-trial-points");
  if (trialPointsEl) {
    trialPointsEl.innerHTML = `
      <div class="print-trial-row"><span class="print-trial-label">助詞與固定搭配：</span>${escapeHtml(card.trialPoints?.particles || "注意格助詞（が/を/に/で/は/へ/から/まで）精確度")}</div>
      <div class="print-trial-row"><span class="print-trial-label">動詞活用與接續：</span>${escapeHtml(card.trialPoints?.conjugations || "注意動詞中頓形與使役/授受/被動變化")}</div>
    `;
  }

  // 4. 正解全文
  const masterBody = document.getElementById("print-master-body");
  if (masterBody) masterBody.textContent = card.bodyText || "";

  // 5. 確保原稿紙本格格子已生成 (200 格與 2 組 120 格)
  ensurePrintGridsGenerated();
}

function ensurePrintGridsGenerated() {
  const p1Grid = document.getElementById("print-grid-cells-page1");
  if (p1Grid && p1Grid.children.length !== 200) {
    p1Grid.innerHTML = "";
    for (let i = 0; i < 200; i++) {
      const cell = document.createElement("div");
      cell.className = "manuscript-cell";
      p1Grid.appendChild(cell);
    }
  }

  const r1Grid = document.getElementById("print-rewrite-grid-1");
  if (r1Grid && r1Grid.children.length !== 120) {
    r1Grid.innerHTML = "";
    for (let i = 0; i < 120; i++) {
      const cell = document.createElement("div");
      cell.className = "manuscript-cell";
      r1Grid.appendChild(cell);
    }
  }

  const r2Grid = document.getElementById("print-rewrite-grid-2");
  if (r2Grid && r2Grid.children.length !== 120) {
    r2Grid.innerHTML = "";
    for (let i = 0; i < 120; i++) {
      const cell = document.createElement("div");
      cell.className = "manuscript-cell";
      r2Grid.appendChild(cell);
    }
  }
}

// =============================================================================
// 白紙審判：零容忍比對演算法 (Diff Engine)
// =============================================================================

const JAPANESE_PARTICLES = ["は", "が", "を", "に", "で", "へ", "と", "から", "まで", "より", "も", "て", "ば", "たり", "ながら"];

function executeJudgment() {
  const userInput = document.getElementById("trial-user-input").value.trim();
  const expectedText = APP_STATE.currentCard.bodyText.trim();

  if (!userInput) {
    alert("請先在白紙盲默輸入框中默寫全文！");
    return;
  }

  // 進行字元層級 Diff 比對 (Myers / LCS algorithm)
  const diffResult = computeCharacterDiff(expectedText, userInput);

  renderJudgmentResult(diffResult, expectedText, userInput);
}

// 簡易高效的字元 LCS 比對
function computeCharacterDiff(expected, actual) {
  const m = expected.length;
  const n = actual.length;

  // 動態規劃求 LCS 矩陣
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (expected[i] === actual[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // 回溯構造 Diff 序列
  let i = m;
  let j = n;
  const diffs = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && expected[i - 1] === actual[j - 1]) {
      diffs.push({ type: "correct", char: expected[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      diffs.push({ type: "extra", char: actual[j - 1] });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      diffs.push({ type: "missing", char: expected[i - 1] });
      i--;
    }
  }

  diffs.reverse();
  return diffs;
}

function renderJudgmentResult(diffs, expectedText, userInput) {
  const cardEl = document.getElementById("judgment-result-card");
  const diffView = document.getElementById("judgment-diff-view");
  const scoreBadge = document.getElementById("judgment-score-badge");
  const statsEl = document.getElementById("judgment-summary-stats");

  let correctCount = 0;
  let missingCount = 0;
  let extraCount = 0;
  let particleErrorCount = 0;

  let html = "";
  diffs.forEach(item => {
    const isParticle = JAPANESE_PARTICLES.includes(item.char);

    if (item.type === "correct") {
      correctCount++;
      html += `<span class="diff-char-correct">${escapeHtml(item.char)}</span>`;
    } else if (item.type === "missing") {
      missingCount++;
      if (isParticle) particleErrorCount++;
      html += `<span class="diff-char-expected ${isParticle ? "diff-particle-highlight" : ""}" title="漏掉文字">[缺:${escapeHtml(item.char)}]</span>`;
    } else if (item.type === "extra") {
      extraCount++;
      if (isParticle) particleErrorCount++;
      html += `<span class="diff-char-wrong" title="多餘或偏差文字">${escapeHtml(item.char)}</span>`;
    }
  });

  diffView.innerHTML = html;

  // 計算精確度
  const totalExpected = expectedText.length;
  const score = Math.max(0, Math.round(((totalExpected - missingCount - extraCount * 0.5) / totalExpected) * 100));

  scoreBadge.textContent = `${score}分 ${score === 100 ? "🎉 完全盲默合格！" : "需強制覆寫"}`;
  if (score === 100) {
    scoreBadge.className = "score-badge score-perfect";
  } else if (score >= 80) {
    scoreBadge.className = "score-badge score-warning";
  } else {
    scoreBadge.className = "score-badge score-danger";
  }

  statsEl.innerHTML = `
    <div>正確字數：<strong>${correctCount}</strong> / ${totalExpected}</div>
    <div>助詞相關偏差：<strong style="color: var(--accent-sakura);">${particleErrorCount}</strong> 處</div>
    <div>漏字/錯字：<strong>${missingCount + extraCount}</strong> 字</div>
  `;

  // 顯現結果卡
  cardEl.classList.add("show");
  cardEl.scrollIntoView({ behavior: "smooth" });

  // 若未達 100 分，顯示強制覆寫工作區
  const overwriteSection = document.getElementById("forced-overwrite-section");
  if (score < 100) {
    overwriteSection.style.display = "block";
    document.querySelectorAll(".read-chk").forEach(chk => chk.checked = false);
    document.getElementById("overwrite-input-1").value = "";
    document.getElementById("overwrite-input-2").value = "";
  } else {
    overwriteSection.style.display = "none";
  }
}

// =============================================================================
// AI 教練改寫引擎 (Gemini API 串接與結構化輸出)
// =============================================================================

const SYSTEM_PROMPT_COACH = `
你現在是我的專屬日語教練，角色設定為：日語極限默寫教練（龍櫻法 × 回音法）。
請根據使用者提供的「日文日常日記」，嚴格按照以下規格將日記改寫為適合「極限默寫（暗記暗誦）」的專用訓練教材。

【核心教學與訓練原則】
1. 目標程度：以 N4～N3 語法骨架為基準，著重加強「助詞精確度」、「動詞活用變形（授受、使役、假定、補助動詞）」與「自然複句接續」。
2. 篇幅限制：改寫後的日文正文嚴格控制在 50～80 字（約 3～4 個完整句子），保持精練、高密度，便於 15 分鐘內進行純白紙盲默。
3. 語法升級：將原文中零碎的「〜て、〜て」串接改為更自然的母語者語塊（如中頓形、ながら、〜た上で、〜について 等）。
4. 格式乾淨：正文不使用括號標註假名，保持視覺純淨。

【底部漢字讀音指引的挑選標準（嚴格限制 4～7 個）】
- 剔除：N5 極基礎直覺詞（如：昨日、仕事、行く、食べる、時間、日本語）。
- 必選：
  1. 音讀複合詞（易搞混長音、促音、濁音者，如：外出、製品、相談、図面）。
  2. 特殊訓讀與名詞（如：妻、お寺、昼、残り）。
  3. 容易讀錯的動詞詞幹與接尾（如：終わらせる、直す）。

請直接輸出合法的 JSON 物件（不要包含任何 markdown 程式碼區塊外多餘閒聊），格式如下：
{
  "title": "短文主題名稱",
  "bodyText": "改寫後50~80字正文，無括號假名",
  "kanjiList": [
    { "kanji": "漢字", "kana": "平假名讀音", "note": "易錯音提示" }
  ],
  "chineseTranslation": "對應母體短文的自然中文翻譯",
  "trialPoints": {
    "particles": "列出 1~2 個默寫時不可漏掉或混淆的助詞與固定搭配點",
    "conjugations": "列出 1~2 個關鍵動詞變形邏輯"
  }
}
`;

// 即時提示訊息更新
function showAiStatus(msg, type) {
  const el = document.getElementById("ai-generate-status");
  if (!el) return;
  el.style.display = "block";
  el.textContent = msg;

  if (type === "success") {
    el.style.background = "rgba(16, 185, 129, 0.15)";
    el.style.border = "1px solid rgba(16, 185, 129, 0.4)";
    el.style.color = "#34d399";
  } else if (type === "error") {
    el.style.background = "rgba(239, 68, 68, 0.15)";
    el.style.border = "1px solid rgba(239, 68, 68, 0.4)";
    el.style.color = "#f87171";
  } else if (type === "warning") {
    el.style.background = "rgba(245, 158, 11, 0.15)";
    el.style.border = "1px solid rgba(245, 158, 11, 0.4)";
    el.style.color = "#fbbf24";
  } else {
    el.style.background = "rgba(99, 102, 241, 0.15)";
    el.style.border = "1px solid rgba(99, 102, 241, 0.4)";
    el.style.color = "#a5b4fc";
  }
}

// 全格式智慧解析器：同時相容 JSON 與 Markdown 四段式格式
function safeParseCardJSON(rawText) {
  return parseCardFromAnyFormat(rawText);
}

function parseCardFromAnyFormat(text) {
  if (!text) throw new Error("API 未返回文字內容");
  let raw = text.trim();

  // 1. 若為 JSON 格式，先嘗試標準 JSON.parse
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]);
      if (obj.bodyText) return obj;
    } catch (e) {
      console.warn("標準 JSON.parse 失敗，進入鍵值容錯抽取模式:", e.message);
    }
  }

  // 1.5 若為 JSON 格式但含有未跳脫引號或控制字元，以鍵值正規表達式精準抽取
  if (raw.includes('"bodyText"')) {
    try {
      const bodyM = raw.match(/"bodyText"\s*:\s*"([\s\S]*?)(?<!\\)"/);
      const titleM = raw.match(/"title"\s*:\s*"([\s\S]*?)(?<!\\)"/);
      const chM = raw.match(/"chineseTranslation"\s*:\s*"([\s\S]*?)(?<!\\)"/);
      const kanjiListM = raw.match(/"kanjiList"\s*:\s*(\[[\s\S]*?\])/);
      const pMatch = raw.match(/"particles"\s*:\s*"([\s\S]*?)(?<!\\)"/);
      const cMatch = raw.match(/"conjugations"\s*:\s*"([\s\S]*?)(?<!\\)"/);

      if (bodyM && bodyM[1]) {
        let kanjiList = [];
        if (kanjiListM) {
          try { kanjiList = JSON.parse(kanjiListM[1]); } catch(e){}
        }
        return {
          title: titleM ? titleM[1] : "極限默寫短文",
          bodyText: bodyM[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim(),
          kanjiList: kanjiList.length > 0 ? kanjiList : [{ kanji: "重要語", kana: "じゅうようご", note: "" }],
          chineseTranslation: chM ? chM[1].replace(/\\n/g, "\n").replace(/\\"/g, '"') : "中文原意對照",
          trialPoints: {
            particles: pMatch ? pMatch[1].replace(/\\"/g, '"') : "注意格助詞",
            conjugations: cMatch ? cMatch[1].replace(/\\"/g, '"') : "注意動詞變形"
          }
        };
      }
    } catch(e) {
      console.warn("JSON 鍵值抽取失敗:", e);
    }
  }

  // 2. 文字/Markdown 四段式格式解析
  let bodyText = "";
  let kanjiList = [];
  let chineseTranslation = "";
  let particles = "";
  let conjugations = "";

  // 擷取 1. 母體短文 (避開「母體短文卡」大標題)
  const m1 = raw.match(/(?:1\.\s*母體短文|母體短文（約)[^\n]*\n([\s\S]*?)(?=(?:2\.\s*漢字讀音|漢字讀音|###\s*2|####\s*2))/i);
  if (m1) {
    bodyText = m1[1].replace(/\[.*?請在此提供.*?\]/g, "").replace(/^[#\*\-\s]+/, "").trim();
  } else {
    const m1Fallback = raw.match(/母體短文[^\n]*\n([\s\S]*?)(?=(?:漢字讀音|###\s*2|####\s*2|\n\s*2\.))/i);
    if (m1Fallback) {
      bodyText = m1Fallback[1].replace(/^[#\*\-\s\d\.]+母體短文[^\n]*\n/, "").replace(/^[#\*\-\s]+/, "").trim();
    }
  }

  // 擷取 2. 漢字讀音指引
  const m2 = raw.match(/(?:2\.\s*漢字讀音|漢字讀音)[^\n]*\n([\s\S]*?)(?=(?:3\.\s*中文原意|中文原意|###\s*3|####\s*3))/i);
  if (m2) {
    const lines = m2[1].split("\n").filter(l => l.includes("（") || l.includes("("));
    lines.forEach(l => {
      const clean = l.replace(/^[\*\-\s#]+/, "").trim();
      const parts = clean.match(/^([^\(（\s]+)[\(（]([^\)）]+)[\)）]/);
      if (parts) {
        kanjiList.push({ kanji: parts[1].trim(), kana: parts[2].trim(), note: "" });
      }
    });
  }

  // 擷取 3. 中文原意對照
  const m3 = raw.match(/(?:3\.\s*中文原意|中文原意)[^\n]*\n([\s\S]*?)(?=(?:4\.\s*白紙審判|白紙審判|###\s*4|####\s*4))/i);
  if (m3) {
    chineseTranslation = m3[1].replace(/^[#\*\-\s]+/, "").replace(/\[.*?\]/g, "").trim();
  }

  // 擷取 4. 白紙審判重點
  const m4 = raw.match(/(?:4\.\s*白紙審判|白紙審判)[^\n]*\n([\s\S]*)/i);
  if (m4) {
    const pMatch = m4[1].match(/(?:助詞與固定搭配|助詞).*?[:：]([^\n]+)/);
    if (pMatch) particles = pMatch[1].trim();
    const cMatch = m4[1].match(/(?:動詞活用與接續|動詞活用|動詞).*?[:：]([^\n]+)/);
    if (cMatch) conjugations = cMatch[1].trim();
  }

  if (!bodyText) {
    if (raw.startsWith("{") && raw.includes('"')) {
      throw new Error("無法解析 AI 回傳內容，請再按一次重試");
    }
    bodyText = raw.trim();
  }

  return {
    title: "極限默寫短文",
    bodyText,
    charCount: bodyText.length,
    kanjiList: kanjiList.length > 0 ? kanjiList : [{ kanji: "重要語", kana: "じゅうようご", note: "" }],
    chineseTranslation: chineseTranslation || "中文原意對照",
    trialPoints: {
      particles: particles || "注意格助詞（が/を/に/で/は/へ）",
      conjugations: conjugations || "注意動詞活用與接續"
    }
  };
}

// 動態向 Google API 查詢此金鑰目前可用的 Gemini 官方模型清單（嚴格排除 gemma 等慢速開源模型）
async function fetchAvailableModels(apiKey) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.models)) {
        // 嚴格只挑選 gemini- 開頭且支援 generateContent 的模型，排除 gemma、embedding、imagen
        const geminiModels = data.models
          .filter(m => m.supportedGenerationMethods && m.supportedGenerationMethods.includes("generateContent"))
          .map(m => m.name.replace("models/", ""))
          .filter(name => name.toLowerCase().startsWith("gemini-") && !name.includes("embedding") && !name.includes("aqa") && !name.includes("imagen"));

        if (geminiModels.length > 0) {
          // 排序：優先將包含 flash 的高速模型排在最前
          geminiModels.sort((a, b) => {
            const aFlash = a.includes("flash") ? 1 : 0;
            const bFlash = b.includes("flash") ? 1 : 0;
            return bFlash - aFlash;
          });
          return geminiModels;
        }
      }
    }
  } catch (e) {
    console.warn("無法取得模型列表:", e);
  }
  return ["gemini-3.8-flash"];
}

async function callGeminiCoach(userDiary) {
  const apiKey = APP_STATE.settings.geminiKey;
  if (!apiKey) {
    openSettingsModal();
    showAiStatus("⚠️ 請先在設定中輸入您的 Gemini API Key！", "warning");
    return;
  }

  const btn = document.getElementById("btn-generate-ai");
  const originalText = btn.innerHTML;
  btn.innerHTML = "<span>⏳</span> 教練正在改寫為極限默寫短文...";
  btn.disabled = true;

  showAiStatus("🔍 正在連接 Google Gemini 極速模型...", "info");

  try {
    // 1. 動態取得目前金鑰真正可用的 Gemini 模型清單（排除慢速 gemma）
    const geminiModels = await fetchAvailableModels(apiKey);
    
    // 候選輪詢清單：優先 3.8-flash，隨後依序輪流嘗試可用 gemini 模型
    const candidateList = [...new Set([
      "gemini-3.8-flash",
      ...geminiModels
    ])];

    let parsedCard = null;
    let lastError = null;

    // 依序嘗試，每個模型最多等候 8 秒，超時立即自動切換下一個模型
    for (const modelToTry of candidateList) {
      try {
        showAiStatus(`⏳ 正在使用模型 [${modelToTry}] 改寫短文中 (約需 1~3 秒)...`, "info");

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 9000); // 9 秒超時切換

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelToTry}:generateContent?key=${apiKey}`;
        const payload = {
          contents: [
            {
              role: "user",
              parts: [
                { text: SYSTEM_PROMPT_COACH },
                { text: `以下是我的日常日記草稿，請為我進行極限默寫改寫：\n${userDiary}` }
              ]
            }
          ],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.3
          }
        };

        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);

        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          const errMsg = errData.error?.message || `HTTP ${res.status}`;
          throw new Error(errMsg);
        }

        const data = await res.json();
        const candidateText = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!candidateText) throw new Error("API 未返回文字內容");

        parsedCard = safeParseCardJSON(candidateText);
        // 成功，更新當前模型
        APP_STATE.settings.geminiModel = modelToTry;
        localStorage.setItem("echo_gemini_model", modelToTry);
        break;
      } catch (err) {
        console.warn(`模型 ${modelToTry} 呼叫未果:`, err);
        lastError = err;
        // 繼續嘗試候選清單的下一個模型
      }
    }

    if (parsedCard && parsedCard.bodyText) {
      parsedCard.id = "card-" + Date.now();
      parsedCard.date = new Date().toISOString().slice(0, 10);
      parsedCard.originalDraft = userDiary;
      parsedCard.charCount = parsedCard.bodyText.length;

      renderCurrentCard(parsedCard);
      saveCardToSnowball(parsedCard);
      showAiStatus(`🎉 教練已成功升級改寫！（正文 ${parsedCard.charCount} 字，符合規格，右側卡片已更新）`, "success");
    } else {
      const isDemandIssue = lastError && (lastError.message.includes("high demand") || lastError.message.includes("spikes") || lastError.name === "AbortError");
      if (isDemandIssue) {
        showAiStatus(`⏳ Google 伺服器目前流量尖峰（High Demand 排隊中），請稍候 3~5 秒後再點擊一次即可！`, "warning");
      } else {
        showAiStatus(`❌ AI 改寫失敗：${lastError ? lastError.message : "未知錯誤"}`, "error");
      }
    }
  } catch (globalErr) {
    showAiStatus(`❌ 發生錯誤: ${globalErr.message}`, "error");
  } finally {
    btn.innerHTML = originalText;
    btn.disabled = false;
  }
}

// 測試 Gemini API Key 連線（若遇尖峰塞車自動分流）
async function testGeminiAPIConnection() {
  const key = document.getElementById("setting-gemini-key").value.trim();
  const selectEl = document.getElementById("setting-gemini-model");
  const model = selectEl.value;
  const statusEl = document.getElementById("api-test-status");

  if (!key) {
    statusEl.style.display = "block";
    statusEl.style.background = "rgba(245, 158, 11, 0.15)";
    statusEl.style.color = "#fbbf24";
    statusEl.textContent = "請先填入 API Key 再進行測試！";
    return;
  }

  statusEl.style.display = "block";
  statusEl.style.background = "rgba(99, 102, 241, 0.15)";
  statusEl.style.color = "#a5b4fc";
  statusEl.textContent = `⏳ 正在向 Google 查詢可用模型並連線測試 (${model})...`;

  // 取得 Google 回傳的真實有效模型清單
  const realModels = await fetchAvailableModels(key);
  const modelsToTest = [model, ...realModels.filter(m => m !== model)];

  let lastError = null;
  let successModel = null;

  for (const m of modelsToTest) {
    try {
      statusEl.textContent = `⏳ 正在測試模型 [${m}]...`;
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: "ping" }] }]
        })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      successModel = m;
      break;
    } catch (err) {
      console.warn(`測試模型 ${m} 失敗:`, err);
      lastError = err;
    }
  }

  if (successModel) {
    if (successModel !== model) {
      selectEl.value = successModel;
      APP_STATE.settings.geminiModel = successModel;
      localStorage.setItem("echo_gemini_model", successModel);
      statusEl.style.background = "rgba(16, 185, 129, 0.15)";
      statusEl.style.color = "#34d399";
      statusEl.textContent = `✅ 連線成功！因 [${model}] 伺服器尖峰壅塞，已自動為您切換至順暢的 [${successModel}]！`;
    } else {
      statusEl.style.background = "rgba(16, 185, 129, 0.15)";
      statusEl.style.color = "#34d399";
      statusEl.textContent = `✅ 連線成功！API Key 與模型 [${model}] 運作正常。`;
    }
  } else {
    const isDemandIssue = lastError && (lastError.message.includes("high demand") || lastError.message.includes("spikes"));
    if (isDemandIssue) {
      statusEl.style.background = "rgba(245, 158, 11, 0.15)";
      statusEl.style.color = "#fbbf24";
      statusEl.textContent = `⚠️ Google 伺服器目前尖峰壅塞排隊中（High Demand）。這是伺服器短暫人潮，金鑰完全正常，請稍候 5~10 秒再測一次即可！`;
    } else {
      statusEl.style.background = "rgba(239, 68, 68, 0.15)";
      statusEl.style.color = "#f87171";
      statusEl.textContent = `❌ 連線失敗: ${lastError ? lastError.message : "未知錯誤"}`;
    }
  }
}

// 手動貼入 / 外部文字解析器
function parseManualCardText(text) {
  try {
    const card = parseCardFromAnyFormat(text);
    if (card) {
      card.id = "manual-" + Date.now();
      card.date = new Date().toISOString().slice(0, 10);
      return card;
    }
  } catch (e) {
    console.error("手動解析失敗:", e);
  }
  return null;
}

// =============================================================================
// 滾雪球記憶庫 (Snowball Review System)
// =============================================================================

function initSnowballCards() {
  const saved = localStorage.getItem("echo_snowball_cards");
  if (saved) {
    try {
      APP_STATE.snowballCards = JSON.parse(saved);
    } catch (e) {
      APP_STATE.snowballCards = [...SAMPLE_CARDS];
    }
  } else {
    APP_STATE.snowballCards = [...SAMPLE_CARDS];
    saveSnowballToStorage();
  }
  renderSnowballGrid();
}

function saveCardToSnowball(card) {
  const existingIdx = APP_STATE.snowballCards.findIndex(c => c.id === card.id);
  if (existingIdx !== -1) {
    APP_STATE.snowballCards[existingIdx] = card;
  } else {
    APP_STATE.snowballCards.unshift(card);
  }
  saveSnowballToStorage();
  renderSnowballGrid();
}

function saveSnowballToStorage() {
  localStorage.setItem("echo_snowball_cards", JSON.stringify(APP_STATE.snowballCards));
}

function renderSnowballGrid() {
  const grid = document.getElementById("snowball-grid");
  if (!grid) return;
  grid.innerHTML = "";

  const todayStr = new Date().toISOString().slice(0, 10);
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  APP_STATE.snowballCards.forEach((card, idx) => {
    const isYesterday = card.date === yesterdayStr || (idx === 1 && card.date !== todayStr);

    const cardBox = document.createElement("div");
    cardBox.className = `snowball-card ${isYesterday ? "yesterday-highlight" : ""}`;
    cardBox.innerHTML = `
      <div>
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px;">
          <span style="font-size: 11px; color: var(--text-muted);">${card.date || "無日期"}</span>
          ${isYesterday ? '<span class="badge badge-gold">⭐ 昨日必默寫</span>' : '<span class="badge badge-indigo">複習存檔</span>'}
        </div>
        <h4 style="font-size: 15px; font-weight: 700; margin-bottom: 6px;">${escapeHtml(card.title || "訓練卡片")}</h4>
        <p style="font-family: var(--font-serif); font-size: 13px; color: var(--text-secondary); line-height: 1.6; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">
          ${escapeHtml(card.bodyText)}
        </p>
      </div>
      <div style="display: flex; justify-content: space-between; align-items: center; margin-top: 14px; border-top: 1px solid var(--border-subtle); padding-top: 10px;">
        <span style="font-size: 11px; color: var(--text-muted);">${card.bodyText.length} 字</span>
        <button class="header-btn" style="padding: 4px 10px; font-size: 11px;">載入練習 ➔</button>
      </div>
    `;

    cardBox.addEventListener("click", () => {
      renderCurrentCard(card);
      switchTab("step-1");
    });

    grid.appendChild(cardBox);
  });
}

// =============================================================================
// 外部音訊下載 (MP3 音檔匯出功能)
// =============================================================================

async function exportAudioFile() {
  const card = APP_STATE.currentCard;
  if (!card || !card.bodyText) {
    alert("無短文可匯出音檔");
    return;
  }

  const btn = document.getElementById("btn-export-audio");
  const origText = btn.innerHTML;
  btn.innerHTML = "<span>⏳</span> 正在生成日語 MP3 音檔...";
  btn.disabled = true;

  // 1. 產生【日期時間 + 短文主題】標準檔名（例如：20261005_1310_日文回音_急な残業を終えた上.mp3）
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const dateStr = `${yyyy}${mm}${dd}_${hh}${min}`;

  // 擷取短文前 10 字作為簡短識別主題，過濾 Windows 不合法檔名字元
  let snippet = (card.bodyText || "").replace(/[。！？\s\r\n\t、,]/g, "").slice(0, 10);
  snippet = snippet.replace(/[\/\\:*?"<>|]/g, "").trim();

  const fileName = `${dateStr}_日文回音_${snippet || "默寫練習"}.mp3`;
  const encodedText = encodeURIComponent(card.bodyText);

  try {
    const voiceName = (APP_STATE.speech.selectedVoice && APP_STATE.speech.selectedVoice.startsWith("edge:"))
      ? APP_STATE.speech.selectedVoice.replace("edge:", "")
      : "ja-JP-NanamiNeural";
    const volume = APP_STATE.speech.volumeBoost || "+100%";

    let rateParam = "+0%";
    if (APP_STATE.speech.rate <= 0.85) rateParam = "-20%";
    else if (APP_STATE.speech.rate >= 1.15) rateParam = "+20%";

    const downloadUrl = `/api/tts?text=${encodedText}&voice=${encodeURIComponent(voiceName)}&volume=${encodeURIComponent(volume)}&rate=${encodeURIComponent(rateParam)}&download=1&filename=${encodeURIComponent(fileName)}`;

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

    if (isIOS) {
      // iOS Safari 原生下載機制：使用 location.href 觸發 Safari 原生下載確認提示「要下載...嗎？」
      window.location.href = downloadUrl;
    } else {
      // 電腦端 Chrome/Edge：使用 a 標籤點擊下載
      const a = document.createElement("a");
      a.href = downloadUrl;
      a.setAttribute("download", fileName);
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }

    btn.innerHTML = "<span>✅</span> 音檔下載已啟動！";
    setTimeout(() => {
      btn.innerHTML = origText;
      btn.disabled = false;
    }, 2500);
  } catch (err) {
    console.warn("Edge-TTS 下載失敗:", err);
    btn.innerHTML = origText;
    btn.disabled = false;
    alert("音檔下載失敗：" + err.message + "\n請確認伺服器正在執行中。");
  }
}

// 同步手機端直接收聽與另存連結
function updateDirectAudioLink() {
  const card = APP_STATE.currentCard;
  if (!card || !card.bodyText) return;
  const link = document.getElementById("link-direct-audio");
  if (!link) return;

  const voiceName = (APP_STATE.speech.selectedVoice && APP_STATE.speech.selectedVoice.startsWith("edge:"))
    ? APP_STATE.speech.selectedVoice.replace("edge:", "")
    : "ja-JP-NanamiNeural";
  const volume = APP_STATE.speech.volumeBoost || "+100%";

  let rateParam = "+0%";
  if (APP_STATE.speech.rate <= 0.85) rateParam = "-20%";
  else if (APP_STATE.speech.rate >= 1.15) rateParam = "+20%";

  link.href = `/api/tts?text=${encodeURIComponent(card.bodyText)}&voice=${encodeURIComponent(voiceName)}&volume=${encodeURIComponent(volume)}&rate=${encodeURIComponent(rateParam)}`;
}

// 麥克風錄音跟讀功能
async function toggleMicrophone() {
  const panel = document.getElementById("mic-record-panel");
  const isOpening = panel.style.display === "none";
  panel.style.display = isOpening ? "block" : "none";

  if (isOpening) {
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";
    const noteEl = document.getElementById("mic-ios-note");

    if (noteEl) {
      if (isIOS || (!isLocalhost && location.protocol !== "https:")) {
        noteEl.style.display = "block";
      } else {
        noteEl.style.display = "none";
      }
    }
  }
}

async function startRecording() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isLocalhost = location.hostname === "localhost" || location.hostname === "127.0.0.1";

  // 檢測瀏覽器環境
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    let msg = "此瀏覽器環境無法存取麥克風。";
    if (isIOS || (!isLocalhost && location.protocol !== "https:")) {
      msg = "【iPhone / 行動裝置使用提示】\n\nApple iOS 安全性規範：非 HTTPS 網址（例如區網 IP http://192.168.x.x）禁止網頁使用麥克風。\n\n💡 建議練習方式：\n1. 在電腦瀏覽器（http://localhost:8088）可直接使用本網頁錄音。\n2. 在 iPhone 上練習時，推薦直接切換至 iPhone 內建的「語音備忘錄（Voice Memos）」App 錄音自我對照！";
    }
    alert(msg);
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    // 自動偵測支援的 MIME 格式 (iOS 支援 audio/mp4，電腦支援 audio/webm)
    let options = {};
    if (typeof MediaRecorder.isTypeSupported === "function") {
      if (MediaRecorder.isTypeSupported("audio/mp4")) {
        options = { mimeType: "audio/mp4" };
      } else if (MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) {
        options = { mimeType: "audio/webm;codecs=opus" };
      } else if (MediaRecorder.isTypeSupported("audio/webm")) {
        options = { mimeType: "audio/webm" };
      }
    }

    APP_STATE.mediaRecorder = new MediaRecorder(stream, options);
    APP_STATE.audioChunks = [];

    APP_STATE.mediaRecorder.ondataavailable = e => {
      if (e.data && e.data.size > 0) {
        APP_STATE.audioChunks.push(e.data);
      }
    };

    APP_STATE.mediaRecorder.onstop = () => {
      const mimeType = options.mimeType || "audio/mp4";
      const audioBlob = new Blob(APP_STATE.audioChunks, { type: mimeType });
      const audioUrl = URL.createObjectURL(audioBlob);
      const audioEl = document.getElementById("recorded-audio");
      audioEl.src = audioUrl;
      audioEl.style.display = "block";
    };

    APP_STATE.mediaRecorder.start();
    document.getElementById("btn-start-record").disabled = true;
    document.getElementById("btn-stop-record").disabled = false;
    document.getElementById("mic-status-text").textContent = "🎙️ 錄音中...請跟著出聲朗讀全文，完成後點擊停止";
  } catch (err) {
    console.error("錄音啟動失敗:", err);
    alert("無法啟用麥克風：" + err.message + "\n請確認已授予麥克風權限。");
  }
}

function stopRecording() {
  if (APP_STATE.mediaRecorder && APP_STATE.mediaRecorder.state !== "inactive") {
    APP_STATE.mediaRecorder.stop();
    document.getElementById("btn-start-record").disabled = false;
    document.getElementById("btn-stop-record").disabled = true;
    document.getElementById("mic-status-text").textContent = "錄音已完成！請點擊右方播放鍵聆聽自己的發音與音調：";
  }
}

// =============================================================================
// 事件監聽與 UI 綁定 (Event Listeners)
// =============================================================================

function initEventListeners() {
  // 主題切換
  document.getElementById("btn-theme-toggle").addEventListener("click", toggleTheme);

  // Tab 分頁切換
  document.querySelectorAll(".step-nav-item").forEach(item => {
    item.addEventListener("click", () => {
      const stepId = item.getAttribute("data-step");
      switchTab(stepId);
    });
  });

  // 快捷範例按鈕
  document.querySelectorAll(".pill-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-sample"), 10);
      if (SAMPLE_CARDS[idx]) {
        const card = SAMPLE_CARDS[idx];
        document.getElementById("input-original-draft").value = card.originalDraft || "";
        updateDraftCharCount();
        renderCurrentCard(card);
      }
    });
  });

  // 日記輸入即時字數統計
  const draftInput = document.getElementById("input-original-draft");
  draftInput.addEventListener("input", updateDraftCharCount);

  // 一鍵 AI 改寫按鈕
  document.getElementById("btn-generate-ai").addEventListener("click", () => {
    const text = draftInput.value.trim();
    if (!text) {
      alert("請先輸入您的日常日文日記草稿！");
      return;
    }
    callGeminiCoach(text);
  });

  // 手動貼入面板切換
  document.getElementById("btn-manual-parse-toggle").addEventListener("click", () => {
    const box = document.getElementById("manual-parse-box");
    box.style.display = box.style.display === "none" ? "block" : "none";
  });

  // 套用手動貼入內容
  document.getElementById("btn-apply-manual-parse").addEventListener("click", () => {
    const text = document.getElementById("manual-paste-text").value;
    const parsed = parseManualCardText(text);
    if (parsed) {
      renderCurrentCard(parsed);
      saveCardToSnowball(parsed);
      alert("卡片內容已解析並載入！");
      document.getElementById("manual-parse-box").style.display = "none";
    } else {
      alert("解析失敗，請確認貼入內容格式。");
    }
  });

  // 儲存至卡庫按鈕
  document.getElementById("btn-save-snowball").addEventListener("click", () => {
    saveCardToSnowball(APP_STATE.currentCard);
    alert("已儲存至滾雪球記憶庫！");
  });

  // 試聽按鈕
  document.getElementById("btn-quick-play-body").addEventListener("click", () => {
    speakText(APP_STATE.currentCard.bodyText);
  });

  // 前往 STEP 2
  document.getElementById("btn-goto-step-2").addEventListener("click", () => {
    switchTab("step-2");
  });

  // STEP 2: 播放主按鈕
  document.getElementById("btn-main-play").addEventListener("click", () => {
    if (APP_STATE.speech.isPlaying) {
      stopEchoPlayback();
    } else {
      startEchoPlayback();
    }
  });

  // 重置計數
  document.getElementById("btn-reset-counter").addEventListener("click", () => {
    APP_STATE.speech.echoCount = 0;
    updateEchoCountUI();
  });

  // 上一句 / 下一句
  document.getElementById("btn-prev-sentence").addEventListener("click", () => {
    if (APP_STATE.speech.currentSentenceIndex > 0) {
      APP_STATE.speech.currentSentenceIndex--;
      if (APP_STATE.speech.isPlaying) {
        if (APP_STATE.speech.pauseTimeoutId) clearTimeout(APP_STATE.speech.pauseTimeoutId);
        stopCurrentPlaybackOnly();
        playNextEchoSentence();
      } else {
        highlightEchoSentence(APP_STATE.speech.currentSentenceIndex);
      }
    }
  });

  document.getElementById("btn-next-sentence").addEventListener("click", () => {
    const sentences = APP_STATE.speech.sentences.length > 0 ? APP_STATE.speech.sentences : splitIntoSentences(APP_STATE.currentCard?.bodyText || "");
    if (APP_STATE.speech.currentSentenceIndex < sentences.length - 1) {
      APP_STATE.speech.currentSentenceIndex++;
      if (APP_STATE.speech.isPlaying) {
        if (APP_STATE.speech.pauseTimeoutId) clearTimeout(APP_STATE.speech.pauseTimeoutId);
        stopCurrentPlaybackOnly();
        playNextEchoSentence();
      } else {
        highlightEchoSentence(APP_STATE.speech.currentSentenceIndex);
      }
    }
  });

  // 語速選項
  document.querySelectorAll("#speed-segmented .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#speed-segmented .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      APP_STATE.speech.rate = parseFloat(btn.getAttribute("data-speed"));
      updateDirectAudioLink();
    });
  });

  // 音量增益選項
  document.querySelectorAll("#volume-segmented .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#volume-segmented .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      APP_STATE.speech.volumeBoost = btn.getAttribute("data-volume");
      updateDirectAudioLink();
    });
  });

  // 回音停頓選項
  document.querySelectorAll("#pause-segmented .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#pause-segmented .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      APP_STATE.speech.pauseDuration = parseFloat(btn.getAttribute("data-pause"));
    });
  });

  // 下載日語音檔
  document.getElementById("btn-export-audio").addEventListener("click", exportAudioFile);

  // 錄音面板與錄音控制
  document.getElementById("btn-toggle-mic").addEventListener("click", toggleMicrophone);
  document.getElementById("btn-start-record").addEventListener("click", startRecording);
  document.getElementById("btn-stop-record").addEventListener("click", stopRecording);

  // 前往 STEP 3
  document.getElementById("btn-goto-step-3").addEventListener("click", () => {
    switchTab("step-3");
  });

  // STEP 3: 盲默字數統計
  const trialInput = document.getElementById("trial-user-input");
  trialInput.addEventListener("input", () => {
    document.getElementById("trial-word-counter").textContent = `${trialInput.value.length} 字`;
  });

  // 盲默聽音提示
  document.getElementById("btn-trial-listen-hint").addEventListener("click", () => {
    speakText(APP_STATE.currentCard.bodyText);
  });

  // 執行白紙審判
  document.getElementById("btn-execute-judgment").addEventListener("click", executeJudgment);

  // A4 列印
  document.getElementById("btn-print-sheet").addEventListener("click", () => {
    window.print();
  });

  // 設定視窗開關與 API 測試
  document.getElementById("btn-open-settings").addEventListener("click", openSettingsModal);
  document.getElementById("btn-close-settings").addEventListener("click", closeSettingsModal);
  document.getElementById("btn-cancel-settings").addEventListener("click", closeSettingsModal);
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);
  document.getElementById("btn-test-api-key").addEventListener("click", testGeminiAPIConnection);

  // 備份與匯入卡庫
  document.getElementById("btn-export-snowball").addEventListener("click", exportSnowballJSON);
  document.getElementById("btn-import-snowball").addEventListener("click", () => {
    document.getElementById("file-import-snowball").click();
  });
  document.getElementById("file-import-snowball").addEventListener("change", importSnowballJSON);
}

function switchTab(stepId) {
  // 切換 TAB
  document.querySelectorAll(".step-nav-item").forEach(item => {
    if (item.getAttribute("data-step") === stepId) {
      item.classList.add("active");
    } else {
      item.classList.remove("active");
    }
  });

  // 切換內容區塊
  document.querySelectorAll(".step-pane").forEach(pane => {
    if (pane.id === stepId) {
      pane.classList.add("active");
    } else {
      pane.classList.remove("active");
    }
  });

  // 如果離開 step-2，暫停回音朗讀
  if (stepId !== "step-2" && APP_STATE.speech.isPlaying) {
    stopEchoPlayback();
  }
}

function updateDraftCharCount() {
  const len = document.getElementById("input-original-draft").value.length;
  document.getElementById("draft-char-count").textContent = `${len} 字`;
}

async function openSettingsModal() {
  document.getElementById("setting-gemini-key").value = APP_STATE.settings.geminiKey;
  document.getElementById("setting-voice-pitch").value = APP_STATE.speech.pitch;
  const statusEl = document.getElementById("api-test-status");
  if (statusEl) statusEl.style.display = "none";
  document.getElementById("modal-settings").classList.add("open");

  // 若已有 API Key，自動向 Google 抓取該金鑰帳戶真實可用的最新模型清單
  if (APP_STATE.settings.geminiKey) {
    const models = await fetchAvailableModels(APP_STATE.settings.geminiKey);
    const select = document.getElementById("setting-gemini-model");
    if (select && models.length > 0) {
      const current = APP_STATE.settings.geminiModel;
      select.innerHTML = "";
      models.forEach(m => {
        const opt = document.createElement("option");
        opt.value = m;
        opt.textContent = m + (m === "gemini-3.8-flash" ? " (最新推薦)" : "");
        select.appendChild(opt);
      });
      select.value = models.includes(current) ? current : models[0];
      APP_STATE.settings.geminiModel = select.value;
      localStorage.setItem("echo_gemini_model", select.value);
    }
  }
}

function closeSettingsModal() {
  document.getElementById("modal-settings").classList.remove("open");
}

function saveSettings() {
  const key = document.getElementById("setting-gemini-key").value.trim();
  const model = document.getElementById("setting-gemini-model").value;
  const pitch = parseFloat(document.getElementById("setting-voice-pitch").value);

  APP_STATE.settings.geminiKey = key;
  APP_STATE.settings.geminiModel = model;
  APP_STATE.speech.pitch = pitch;

  localStorage.setItem("echo_gemini_key", key);
  localStorage.setItem("echo_gemini_model", model);

  closeSettingsModal();
  alert("設定已儲存！");
}

function exportSnowballJSON() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(APP_STATE.snowballCards, null, 2));
  const dlAnchor = document.createElement("a");
  dlAnchor.setAttribute("href", dataStr);
  dlAnchor.setAttribute("download", `snowball_cards_${new Date().toISOString().slice(0, 10)}.json`);
  dlAnchor.click();
}

function importSnowballJSON(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const imported = JSON.parse(event.target.result);
      if (Array.isArray(imported)) {
        APP_STATE.snowballCards = imported;
        saveSnowballToStorage();
        renderSnowballGrid();
        alert(`成功匯入 ${imported.length} 篇卡片！`);
      } else {
        alert("匯入格式不正確，需為卡片陣列 JSON。");
      }
    } catch (err) {
      alert("無法解析 JSON 檔案：" + err.message);
    }
  };
  reader.readAsText(file);
}

function escapeHtml(str) {
  if (!str) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
