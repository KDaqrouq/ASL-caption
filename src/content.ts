import { clampToViewport, makeDraggable, placeAt } from './draggable';
import {
  CONNECT,
  OUTGOING_EVENT,
  type CameraMessage,
  type ControlMessage,
  type OutgoingMessage,
} from './messages';
import overlayCss from './overlay.css?raw';
import { MAX_PHRASES, caption, cleanPhraseText, newPhraseId, shortText, type Phrase } from './phrases';
import { trimToHands } from './recognition/features';
import { Recognizer } from './recognition/recognizer';
import { Segmenter } from './recognition/segmenter';
import type { Frame, Prediction, Sample } from './recognition/types';
import * as store from './storage';

const HOST_ID = 'asl-meet-captions-host';
const HIGH_CONFIDENCE = 0.66;
const SUBTITLE_MS = 4000;
/** Translate uses a sign that ended at most this long ago. */
const RECENT_SIGN_MS = 4000;
/** Translate pressed mid-sign waits at most this long for the sign to finish. */
const WAIT_FOR_SIGN_MS = 3000;
const COUNTDOWN_STEPS = 3;
const COUNTDOWN_STEP_MS = 600;
const RECORD_TIMEOUT_MS = 6000;
const SUGGESTED_EXAMPLES = 5;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, className = '', title?: string): HTMLButtonElement {
  const b = el('button', className, text);
  b.type = 'button';
  if (title) {
    b.title = title;
    b.setAttribute('aria-label', title);
  }
  return b;
}

/** A button that asks "Sure?" on the first click and acts on the second. */
function confirmButton(text: string, className: string, title: string, onConfirm: () => void): HTMLButtonElement {
  const b = button(text, className, title);
  let armed: ReturnType<typeof setTimeout> | null = null;
  b.addEventListener('click', () => {
    if (!armed) {
      b.textContent = text.length > 2 ? 'Sure?' : '?';
      b.classList.add('asl-armed');
      armed = setTimeout(() => {
        armed = null;
        b.textContent = text;
        b.classList.remove('asl-armed');
      }, 3000);
      return;
    }
    clearTimeout(armed);
    armed = null;
    b.textContent = text;
    b.classList.remove('asl-armed');
    onConfirm();
  });
  return b;
}

/** True when a key press is meant for a text field (also inside shadow roots). */
function isTypingTarget(e: KeyboardEvent): boolean {
  const t = e.composedPath()[0];
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || !!t.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])');
}

const pct = (c: number) => `${Math.round(c * 100)}%`;
const quote = (p: Phrase) => `“${shortText(p)}”`;

class MeetCaptionsApp {
  private tracking: 'loading' | 'ready' | 'error' = 'loading';
  private trackingError = '';
  private cameraError: string | null = null;
  private port: MessagePort | null = null;
  private segmenter = new Segmenter();
  private phrases: Phrase[] = [];
  private samples: store.StoredSample[] = [];
  private model = new Recognizer([], 0);
  private settings: store.Settings = { autoCaption: false, captionVideo: true, panel: null, collapsed: false };

  /** Most recent completed sign, so Translate can caption it after the fact. */
  private lastSign: { frames: Frame[]; endedAt: number; used: boolean } | null = null;
  private pendingTranslateUntil: number | null = null;
  private recording: { phraseId: string; until: number } | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;

  private fadeTimer: ReturnType<typeof setTimeout> | null = null;
  private subtitleClearTimer: ReturnType<typeof setTimeout> | null = null;
  private triggerLock = false;

  /** Shadow-tree root; overlays must live here (light-DOM children of the host are not rendered). */
  private uiRoot!: HTMLElement;
  private panel!: HTMLElement;
  private cameraFrame!: HTMLIFrameElement;
  private collapseBtn!: HTMLButtonElement;
  private statusEl!: HTMLElement;
  private subtitleEl!: HTMLElement;
  private subtitleWrap!: HTMLElement;
  private autoCheckbox!: HTMLInputElement;
  private videoCheckbox!: HTMLInputElement;
  private teachBtn!: HTMLButtonElement;
  private teachEl!: HTMLElement;
  private teachList!: HTMLElement;
  private newPhraseInput!: HTMLInputElement;
  private addPhraseBtn!: HTMLButtonElement;
  private evalEl!: HTMLElement;
  private fallbackEl: HTMLElement | null = null;

  async mount(root: HTMLElement): Promise<void> {
    this.uiRoot = root;
    this.buildUi(root);
    this.setTracking('loading');
    this.setStatus('Loading hand tracking…');
    this.connectCamera();

    const [phrases, samples, settings] = await Promise.all([store.loadPhrases(), store.loadSamples(), store.loadSettings()]);
    this.phrases = phrases;
    this.samples = samples;
    this.settings = settings;
    this.autoCheckbox.checked = settings.autoCaption;
    this.videoCheckbox.checked = settings.captionVideo;
    this.sendOutgoing({ type: 'enabled', on: settings.captionVideo });
    this.setCollapsed(settings.collapsed, false);
    if (settings.panel) placeAt(this.panel, clampToViewport(this.panel, settings.panel));
    this.renderTeachList();
    this.rebuildModel();
    this.refreshStatus();

    window.addEventListener('keydown', this.onGlobalKeydown, true);
    window.addEventListener('resize', () => {
      if (this.settings.panel) placeAt(this.panel, clampToViewport(this.panel, this.settings.panel));
    });
  }

  // ---------------------------------------------------------------- camera frame

  /** Opens a private channel to the camera frame once it has loaded. */
  private connectCamera(): void {
    const connect = () => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e: MessageEvent<CameraMessage>) => this.onCameraMessage(e.data);
      this.port?.close();
      this.port = channel.port1;
      this.cameraFrame.contentWindow?.postMessage(CONNECT, new URL(chrome.runtime.getURL('')).origin, [channel.port2]);
    };
    this.cameraFrame.addEventListener('load', connect);
  }

  private onCameraMessage(msg: CameraMessage): void {
    switch (msg.type) {
      case 'frame':
        this.onFrame(msg.frame);
        break;
      case 'camera':
        this.cameraError = msg.ok ? null : (msg.error ?? 'unknown error');
        this.refreshStatus();
        break;
      case 'status':
        this.setTracking(msg.tracking);
        this.trackingError = msg.error ?? '';
        this.refreshStatus();
        break;
    }
  }

  private sendControl(msg: ControlMessage): void {
    this.port?.postMessage(msg);
  }

  /** Talks to the page hook that draws captions into the outgoing video (pageHook.ts). */
  private sendOutgoing(msg: OutgoingMessage): void {
    window.dispatchEvent(new CustomEvent(OUTGOING_EVENT, { detail: JSON.stringify(msg) }));
  }

  // ---------------------------------------------------------------- UI

  private buildUi(root: HTMLElement): void {
    this.panel = el('div', 'asl-panel');

    const header = el('div', 'asl-header');
    header.title = 'Drag to move';
    this.collapseBtn = button('–', 'asl-collapse', 'Minimise');
    this.collapseBtn.addEventListener('click', () => this.setCollapsed(true));
    header.append(el('span', 'asl-dot'), el('span', 'asl-title', 'ASL captions'), this.collapseBtn);

    // Webcam preview and hand tracking live in an extension frame (see camera.ts).
    this.cameraFrame = el('iframe', 'asl-camera');
    this.cameraFrame.allow = 'camera';
    this.cameraFrame.title = 'ASL captions camera';
    this.cameraFrame.tabIndex = -1;
    this.cameraFrame.src = chrome.runtime.getURL('camera.html');

    const translateBtn = button('Translate', 'asl-primary', 'Caption the last sign (Space)');
    translateBtn.addEventListener('click', () => void this.onTranslate());
    this.teachBtn = button('Teach', 'asl-secondary', 'Record examples of each phrase');
    this.teachBtn.setAttribute('aria-expanded', 'false');
    this.teachBtn.addEventListener('click', () => this.toggleTeach());
    const row = el('div', 'asl-row');
    row.append(translateBtn, this.teachBtn);

    this.statusEl = el('div', 'asl-status');
    this.statusEl.setAttribute('role', 'status');

    const [autoRow, autoCheckbox] = this.checkboxRow('Auto-caption each sign', () => {
      this.updateSettings({ autoCaption: this.autoCheckbox.checked });
      this.setIdleStatus();
    });
    this.autoCheckbox = autoCheckbox;
    const [videoRow, videoCheckbox] = this.checkboxRow('Show captions in my video', () => {
      this.updateSettings({ captionVideo: this.videoCheckbox.checked });
      this.sendOutgoing({ type: 'enabled', on: this.videoCheckbox.checked });
    });
    videoRow.title = 'Draw captions into the camera video the other participants see';
    this.videoCheckbox = videoCheckbox;

    this.teachEl = this.buildTeachSection();
    this.teachEl.hidden = true;

    this.panel.append(header, this.cameraFrame, row, this.statusEl, autoRow, videoRow, this.teachEl);

    makeDraggable(this.panel, {
      canStart: (t) => this.panel.classList.contains('asl-collapsed') || !!t.closest('.asl-header'),
      onDrop: (pos) => this.updateSettings({ panel: pos }),
      onClick: () => {
        if (this.panel.classList.contains('asl-collapsed')) this.setCollapsed(false);
      },
    });
    this.panel.addEventListener('keydown', (e) => {
      if (this.panel.classList.contains('asl-collapsed') && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        e.stopPropagation();
        this.setCollapsed(false);
      }
    });

    this.subtitleWrap = el('div', 'asl-subtitle-wrap');
    this.subtitleWrap.style.display = 'none';
    this.subtitleEl = el('div', 'asl-subtitle');
    this.subtitleEl.setAttribute('aria-live', 'polite');
    this.subtitleWrap.appendChild(this.subtitleEl);

    root.append(this.panel, this.subtitleWrap);
  }

  private checkboxRow(text: string, onChange: () => void): [HTMLLabelElement, HTMLInputElement] {
    const label = el('label', 'asl-check-row');
    const input = el('input');
    input.type = 'checkbox';
    input.addEventListener('change', onChange);
    label.append(input, el('span', '', text));
    return [label, input];
  }

  private buildTeachSection(): HTMLElement {
    const section = el('div', 'asl-teach');
    section.appendChild(
      el(
        'p',
        'asl-hint',
        `Record each phrase about ${SUGGESTED_EXAMPLES} times: press ●, wait for the countdown, sign once, then lower your hands.`,
      ),
    );

    this.teachList = el('div', 'asl-teach-list');
    section.appendChild(this.teachList);

    const addRow = el('form', 'asl-add-row');
    this.newPhraseInput = el('input');
    this.newPhraseInput.type = 'text';
    this.newPhraseInput.placeholder = 'Add a phrase, e.g. Hello everyone';
    this.newPhraseInput.setAttribute('aria-label', 'New phrase');
    this.newPhraseInput.maxLength = 80;
    this.addPhraseBtn = button('Add', 'asl-secondary', 'Add this phrase');
    this.addPhraseBtn.type = 'submit';
    addRow.append(this.newPhraseInput, this.addPhraseBtn);
    addRow.addEventListener('submit', (e) => {
      e.preventDefault();
      this.addPhrase(this.newPhraseInput.value);
    });
    section.appendChild(addRow);

    this.evalEl = el('div', 'asl-eval');
    section.appendChild(this.evalEl);

    const tools = el('div', 'asl-tools');
    const selfTest = button('Self-test', '', 'Estimate accuracy by classifying each example against the others');
    selfTest.addEventListener('click', () => this.runSelfTest());
    const exportBtn = button('Export', '', 'Download your phrases and examples as a file');
    exportBtn.addEventListener('click', () => this.exportSamples());
    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'application/json,.json';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => void this.importSamples(fileInput));
    const importBtn = button('Import', '', 'Add phrases and examples from an exported file');
    importBtn.addEventListener('click', () => fileInput.click());
    const clearBtn = confirmButton('Clear', 'asl-danger', 'Delete all examples', () =>
      void this.replaceSamples([], 'Deleted all examples.'),
    );
    tools.append(selfTest, exportBtn, importBtn, clearBtn, fileInput);
    section.appendChild(tools);
    return section;
  }

  /** Rebuilds the phrase rows (after phrases are added or removed). */
  private renderTeachList(): void {
    this.teachList.replaceChildren(
      ...this.phrases.map((p) => {
        const item = el('div', 'asl-teach-row');
        item.dataset.phraseId = p.id;
        const label = el('span', 'asl-teach-label', shortText(p));
        label.title = p.gloss ? `${p.text} (suggested sign: ${p.gloss})` : p.text;
        const count = el('span', 'asl-count', '0');
        const record = button('●', 'asl-rec', `Record an example of ${quote(p)}`);
        record.addEventListener('click', () => this.startRecording(p.id));
        const undo = button('↶', 'asl-undo', `Delete the last example of ${quote(p)}`);
        undo.addEventListener('click', () => this.deleteLastSample(p.id));
        const remove = confirmButton('×', 'asl-remove', `Remove the phrase ${quote(p)} and its examples`, () =>
          this.removePhrase(p.id),
        );
        item.append(label, count, record, undo, remove);
        return item;
      }),
    );
    const full = this.phrases.length >= MAX_PHRASES;
    this.newPhraseInput.disabled = full;
    this.addPhraseBtn.disabled = full;
    this.refreshTeachCounts();
  }

  private toggleTeach(): void {
    const open = this.teachEl.hidden !== false;
    this.teachEl.hidden = !open;
    this.panel.classList.toggle('asl-teaching', open);
    this.teachBtn.setAttribute('aria-expanded', String(open));
    this.keepPanelOnScreen();
  }

  private setCollapsed(collapsed: boolean, save = true): void {
    this.panel.classList.toggle('asl-collapsed', collapsed);
    if (collapsed) {
      this.panel.tabIndex = 0;
      this.panel.setAttribute('role', 'button');
      this.panel.setAttribute('aria-label', 'Show ASL captions panel');
      this.panel.title = `${this.statusEl.textContent ?? ''}\nClick to expand, drag to move.`;
      this.closeFallback();
    } else {
      this.panel.removeAttribute('tabindex');
      this.panel.removeAttribute('role');
      this.panel.removeAttribute('aria-label');
      this.panel.title = '';
    }
    if (save) this.updateSettings({ collapsed });
    this.keepPanelOnScreen();
  }

  /** After the panel changes size, nudge it back inside the window if it was moved. */
  private keepPanelOnScreen(): void {
    if (!this.settings.panel) return;
    requestAnimationFrame(() => placeAt(this.panel, clampToViewport(this.panel, this.settings.panel!)));
  }

  private updateSettings(patch: Partial<store.Settings>): void {
    this.settings = { ...this.settings, ...patch };
    void store.saveSettings(this.settings);
  }

  private refreshTeachCounts(): void {
    const counts = new Map<string, number>();
    for (const s of this.samples) counts.set(s.phraseId, (counts.get(s.phraseId) ?? 0) + 1);
    for (const row of this.teachList.children) {
      const id = (row as HTMLElement).dataset.phraseId ?? '';
      const n = counts.get(id) ?? 0;
      const count = row.querySelector('.asl-count')!;
      count.textContent = String(n);
      count.classList.toggle('asl-enough', n >= SUGGESTED_EXAMPLES);
      (row.querySelector('.asl-undo') as HTMLButtonElement).disabled = n === 0;
    }
    this.panel.dataset.samples = String(this.samples.length);
    this.evalEl.textContent = '';
  }

  private setStatus(text: string): void {
    this.statusEl.textContent = text;
    if (this.panel.classList.contains('asl-collapsed')) {
      this.panel.title = `${text}\nClick to expand, drag to move.`;
    }
  }

  private setTracking(state: 'loading' | 'ready' | 'error'): void {
    this.tracking = state;
    this.panel.dataset.tracking = state;
  }

  private refreshStatus(): void {
    if (this.cameraError) {
      this.setStatus(`Camera blocked: ${this.cameraError}. Allow the webcam for meet.google.com.`);
    } else if (this.tracking === 'error') {
      this.setStatus(`Hand tracking could not start (${this.trackingError}). Try reloading the page.`);
    } else if (this.tracking === 'loading') {
      this.setStatus('Loading hand tracking…');
    } else {
      this.setIdleStatus();
    }
  }

  private setIdleStatus(): void {
    if (this.tracking !== 'ready' || this.cameraError) return;
    if (this.model.sampleCount === 0) {
      this.setStatus('No signs taught yet. Click Teach to record your phrases.');
    } else if (this.settings.autoCaption) {
      this.setStatus('Sign a phrase; captions appear automatically.');
    } else {
      this.setStatus('Sign a phrase, then press Space or Translate.');
    }
  }

  // ---------------------------------------------------------------- frames and signs

  private onFrame(frame: Frame): void {
    const hands = String(frame.hands.length);
    if (this.panel.dataset.hands !== hands) this.panel.dataset.hands = hands;

    const sign = this.segmenter.push(frame);
    this.panel.classList.toggle('asl-signing', this.segmenter.active);
    if (sign) this.onSign(sign);

    const now = performance.now();
    if (this.recording && now > this.recording.until) {
      const frames = this.segmenter.flush();
      if (frames) this.onSign(frames);
      else this.finishRecording(null);
    }
    if (this.pendingTranslateUntil !== null && now > this.pendingTranslateUntil) {
      this.pendingTranslateUntil = null;
      const frames = this.segmenter.flush();
      if (frames) this.translate(frames, true);
      else this.setStatus("I didn't catch a complete sign. Try again.");
    }
  }

  private phrase(id: string): Phrase | undefined {
    return this.phrases.find((p) => p.id === id);
  }

  private rebuildModel(): void {
    const index = new Map(this.phrases.map((p, i) => [p.id, i]));
    const samples: Sample[] = [];
    for (const s of this.samples) {
      const i = index.get(s.phraseId);
      if (i !== undefined) samples.push({ phrase: i, frames: s.frames, createdAt: s.createdAt });
    }
    this.model = new Recognizer(samples, this.phrases.length);
    this.refreshTeachCounts();
  }

  private onSign(frames: Frame[]): void {
    if (this.recording) {
      this.finishRecording(frames);
      return;
    }
    if (this.countdownTimer) return;
    this.lastSign = { frames, endedAt: performance.now(), used: false };
    if (this.pendingTranslateUntil !== null) {
      this.pendingTranslateUntil = null;
      this.translate(frames, true);
    } else if (this.settings.autoCaption && this.model.sampleCount > 0) {
      this.translate(frames, false);
    } else if (this.model.sampleCount > 0) {
      this.setStatus('Sign captured. Press Space or Translate to caption it.');
    }
  }

  private onGlobalKeydown = (e: KeyboardEvent): void => {
    if (e.code !== 'Space' || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    void this.onTranslate();
  };

  private async onTranslate(): Promise<void> {
    if (this.triggerLock || this.recording || this.countdownTimer) return;
    this.triggerLock = true;
    setTimeout(() => {
      this.triggerLock = false;
    }, 400);
    this.closeFallback();

    if (this.tracking !== 'ready' || this.cameraError) {
      this.setStatus('Hand tracking is not running; choose the phrase instead.');
      this.showFallback(null, null);
      return;
    }
    if (this.model.sampleCount === 0) {
      this.setStatus('No signs taught yet. Click Teach to record your phrases.');
      this.showFallback(null, null);
      return;
    }

    const last = this.lastSign;
    if (last && !last.used && performance.now() - last.endedAt < RECENT_SIGN_MS) {
      this.translate(last.frames, true);
    } else if (this.segmenter.active) {
      this.pendingTranslateUntil = performance.now() + WAIT_FOR_SIGN_MS;
      this.setStatus('Finish the sign…');
    } else {
      const recent = trimToHands(this.segmenter.recent(2500));
      if (recent.filter((f) => f.hands.length > 0).length >= 6) {
        this.translate(recent, true);
      } else {
        this.setStatus("I didn't see a sign. Sign a phrase, then press Space.");
      }
    }
  }

  /** Classifies a sign; `manual` means the user asked (Space/Translate) rather than auto-caption. */
  private translate(frames: Frame[], manual: boolean): void {
    const pred = this.model.classify(frames);
    if (this.lastSign?.frames === frames) this.lastSign.used = true;
    const p = pred ? this.phrases[pred.index] : undefined;
    this.panel.dataset.lastPrediction = pred && p ? `${p.id}:${pred.confidence.toFixed(2)}` : 'none';

    if (pred && p && pred.confidence >= HIGH_CONFIDENCE) {
      this.showSubtitle(p);
      this.setStatus(`Recognised ${quote(p)} (${pct(pred.confidence)}).`);
    } else if (manual) {
      this.setStatus('Not sure about that one. Confirm or pick the phrase.');
      this.showFallback(pred, frames);
    } else {
      // Auto mode never interrupts with a dialog; Space reviews the uncertain sign.
      if (this.lastSign?.frames === frames) this.lastSign.used = false;
      this.setStatus(
        p ? `Not sure (maybe ${quote(p)}, ${pct(pred!.confidence)}). Press Space to review.` : 'Sign not recognised.',
      );
    }
  }

  /** Stores a corrected or confirmed sign as a new example, so the model adapts over time. */
  private learn(p: Phrase, frames: Frame[] | null): void {
    if (!frames || frames.length === 0) return;
    void this.replaceSamples(store.withSample(this.samples, p.id, frames), `Learned this sign as ${quote(p)}.`);
  }

  // ---------------------------------------------------------------- teaching

  private startRecording(phraseId: string): void {
    const p = this.phrase(phraseId);
    if (!p || this.recording || this.countdownTimer) return;
    if (this.tracking !== 'ready' || this.cameraError) {
      this.setStatus('Hand tracking is not running, so examples cannot be recorded.');
      return;
    }
    this.closeFallback();
    this.pendingTranslateUntil = null;
    this.panel.classList.add('asl-recording');
    let n = COUNTDOWN_STEPS;
    const step = () => {
      if (n > 0) {
        this.setStatus(`Get ready to sign ${quote(p)}… ${n}`);
        n--;
        this.countdownTimer = setTimeout(step, COUNTDOWN_STEP_MS);
        return;
      }
      this.countdownTimer = null;
      this.segmenter.arm();
      this.recording = { phraseId, until: performance.now() + RECORD_TIMEOUT_MS };
      this.sendControl({ type: 'recording', on: true });
      this.setStatus(`Sign ${quote(p)} now, then lower your hands.`);
    };
    step();
  }

  private finishRecording(frames: Frame[] | null): void {
    const rec = this.recording;
    this.recording = null;
    this.panel.classList.remove('asl-recording');
    this.sendControl({ type: 'recording', on: false });
    const p = rec && this.phrase(rec.phraseId);
    if (!p) return;
    if (!frames) {
      this.setStatus("I didn't see a sign. Make sure your hands are in view and try again.");
      return;
    }
    const count = this.samples.filter((s) => s.phraseId === p.id).length + 1;
    void this.replaceSamples(
      store.withSample(this.samples, p.id, frames),
      `Saved example ${Math.min(count, store.MAX_SAMPLES_PER_PHRASE)} of ${quote(p)}.`,
    );
  }

  private deleteLastSample(phraseId: string): void {
    const p = this.phrase(phraseId);
    const idx = this.samples.map((s) => s.phraseId).lastIndexOf(phraseId);
    if (!p || idx < 0) return;
    void this.replaceSamples(
      this.samples.filter((_, i) => i !== idx),
      `Deleted the last example of ${quote(p)}.`,
    );
  }

  private addPhrase(raw: string): void {
    const text = cleanPhraseText(raw);
    if (!text) return;
    if (this.phrases.length >= MAX_PHRASES) {
      this.setStatus(`You can have up to ${MAX_PHRASES} phrases.`);
      return;
    }
    const existing = this.phrases.find((p) => p.text.toLowerCase() === text.toLowerCase());
    if (existing) {
      this.setStatus(`${quote(existing)} is already in the list.`);
      return;
    }
    const p: Phrase = { id: newPhraseId(), text };
    this.newPhraseInput.value = '';
    void this.replacePhrases([...this.phrases, p], this.samples, `Added ${quote(p)}. Press ● to teach it.`);
  }

  private removePhrase(phraseId: string): void {
    const p = this.phrase(phraseId);
    if (!p) return;
    void this.replacePhrases(
      this.phrases.filter((q) => q.id !== phraseId),
      this.samples.filter((s) => s.phraseId !== phraseId),
      `Removed ${quote(p)}.`,
    );
  }

  private async replacePhrases(phrases: Phrase[], samples: store.StoredSample[], message: string): Promise<void> {
    this.phrases = phrases;
    this.closeFallback();
    this.renderTeachList();
    await this.replaceSamples(samples, message);
    try {
      await store.savePhrases(phrases);
    } catch (e) {
      this.setStatus(`Could not save phrases: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async replaceSamples(samples: store.StoredSample[], message: string): Promise<void> {
    this.samples = samples;
    this.rebuildModel();
    this.setStatus(message);
    try {
      await store.saveSamples(samples);
    } catch (e) {
      this.setStatus(`Could not save examples: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private runSelfTest(): void {
    const ev = this.model.evaluate();
    if (ev.accuracy === null) {
      this.evalEl.textContent = 'Teach at least two phrases to run a self-test.';
      return;
    }
    const weak = ev.perPhrase
      .map((r, i) => ({ ...r, p: this.phrases[i] }))
      .filter((r) => r.total > 0 && r.correct / r.total < 0.8)
      .map((r) => quote(r.p));
    this.evalEl.textContent =
      `Self-test: ${pct(ev.accuracy)} of examples recognised.` +
      (weak.length ? ` Add more examples of ${weak.join(', ')}.` : '');
  }

  private exportSamples(): void {
    const blob = new Blob([store.exportJson({ phrases: this.phrases, samples: this.samples })], {
      type: 'application/json',
    });
    const a = el('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'asl-meet-captions-examples.json';
    this.uiRoot.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }

  private async importSamples(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    try {
      const merged = store.mergeImport(
        { phrases: this.phrases, samples: this.samples },
        store.importJson(await file.text()),
      );
      await this.replacePhrases(merged.phrases, merged.samples, `Imported ${merged.added} examples.`);
    } catch (e) {
      this.setStatus(`Import failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ---------------------------------------------------------------- captions

  private showSubtitle(p: Phrase): void {
    const text = caption(p);
    if (this.settings.captionVideo) this.sendOutgoing({ type: 'caption', text });
    if (this.fadeTimer) clearTimeout(this.fadeTimer);
    if (this.subtitleClearTimer) clearTimeout(this.subtitleClearTimer);

    this.subtitleEl.classList.remove('asl-fade');
    this.subtitleEl.textContent = text;
    this.subtitleWrap.style.display = 'block';

    this.fadeTimer = setTimeout(() => {
      this.subtitleEl.classList.add('asl-fade');
    }, SUBTITLE_MS);

    this.subtitleClearTimer = setTimeout(() => {
      this.subtitleEl.textContent = '';
      this.subtitleWrap.style.display = 'none';
      this.subtitleEl.classList.remove('asl-fade');
    }, SUBTITLE_MS + 500);
  }

  private showFallback(pred: Prediction | null, frames: Frame[] | null): void {
    this.closeFallback();
    if (this.phrases.length === 0) {
      this.setStatus('Add a phrase in Teach first.');
      return;
    }
    const guess = pred ? this.phrases[pred.index] : undefined;
    const card = el('div', 'asl-fallback');
    card.setAttribute('role', 'dialog');

    card.appendChild(el('h3', '', guess ? 'Low confidence' : 'Choose a phrase'));
    if (guess && pred) {
      card.appendChild(el('div', 'asl-guess', `Best guess: ${caption(guess)} (${pct(pred.confidence)})`));
      const actions = el('div', 'asl-actions');
      const confirmBtn = button('Confirm', 'confirm');
      confirmBtn.addEventListener('click', () => {
        this.showSubtitle(guess);
        this.closeFallback();
        this.learn(guess, frames);
      });
      const retryBtn = button('Retry', 'retry');
      retryBtn.addEventListener('click', () => {
        this.closeFallback();
        this.setStatus('Try again: sign the phrase, then press Space or Translate.');
      });
      actions.append(confirmBtn, retryBtn);
      card.appendChild(actions);
      card.appendChild(el('div', 'asl-guess', 'Or choose a phrase:'));
    }

    const select = el('select');
    for (const p of this.phrases) {
      const opt = el('option', '', caption(p));
      opt.value = p.id;
      if (p === guess) opt.selected = true;
      select.appendChild(opt);
    }

    const chooseRow = el('div', 'choose-row');
    const applyBtn = button('Use selection');
    applyBtn.addEventListener('click', () => {
      const p = this.phrase(select.value);
      this.closeFallback();
      if (!p) return;
      this.showSubtitle(p);
      this.learn(p, frames);
    });
    const cancelBtn = button('Cancel', 'retry');
    cancelBtn.addEventListener('click', () => this.closeFallback());
    chooseRow.append(applyBtn, cancelBtn);

    card.append(select, chooseRow);
    this.uiRoot.appendChild(card);
    this.fallbackEl = card;
  }

  private closeFallback(): void {
    this.fallbackEl?.remove();
    this.fallbackEl = null;
  }
}

function main(): void {
  if (document.getElementById(HOST_ID)) return;

  const host = document.createElement('div');
  host.id = HOST_ID;
  document.documentElement.appendChild(host);

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = overlayCss;
  shadow.appendChild(style);

  const inner = document.createElement('div');
  inner.setAttribute('data-asl-overlay', '1');
  shadow.appendChild(inner);

  const app = new MeetCaptionsApp();
  void app.mount(inner);
}

main();
