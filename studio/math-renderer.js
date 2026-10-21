/**
 * Academic LaTeX Math, Superscript/Affiliation & Rich Text Renderer for Immersive Gemini Studio.
 * Zero-eval, 100% MV3 CSP compliant.
 *
 * Capabilities:
 * 1. Renders display math ($$...$$, \[...\], \begin{equation/align/aligned...}, or equation blocks)
 *    and inline math ($...$, \(...\)) into publication-grade HTML mathematical notation.
 * 2. Supports stacked fractions (\frac, \dfrac, \tfrac), roots (\sqrt), big operators with limits
 *    (\sum, \prod, \int, \lim, \max, \min, \arg\max, \arg\min), matrices/cases (\begin{cases/pmatrix/bmatrix...}),
 *    accents (\hat, \tilde, \bar, \vec, \overline), font styles (\mathbb, \mathcal, \mathbf, \text, \mathrm, \operatorname),
 *    Greek letters, mathematical relations/arrows/operators, and nested subscripts/superscripts.
 * 3. Detects and formats academic author & affiliation blocks (e.g., Ziyang Song$^{1,*}$ ... $^{1}$University...)
 *    with proper superscripts and clean line breaks.
 */

import { escapeHtml } from '../shared/utils.js';

const GREEK_AND_SYMBOLS = {
  // Lowercase Greek
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  delta: 'δ',
  epsilon: 'ϵ',
  varepsilon: 'ε',
  zeta: 'ζ',
  eta: 'η',
  theta: 'θ',
  vartheta: 'ϑ',
  iota: 'ι',
  kappa: 'κ',
  lambda: 'λ',
  mu: 'μ',
  nu: 'ν',
  xi: 'ξ',
  pi: 'π',
  varpi: 'ϖ',
  rho: 'ρ',
  varrho: 'ϱ',
  sigma: 'σ',
  varsigma: 'ς',
  tau: 'τ',
  upsilon: 'υ',
  phi: 'ϕ',
  varphi: 'φ',
  chi: 'χ',
  psi: 'ψ',
  omega: 'ω',

  // Uppercase Greek
  Gamma: 'Γ',
  Delta: 'Δ',
  Theta: 'Θ',
  Lambda: 'Λ',
  Xi: 'Ξ',
  Pi: 'Π',
  Sigma: 'Σ',
  Upsilon: 'Υ',
  Phi: 'Φ',
  Psi: 'Ψ',
  Omega: 'Ω',

  // Big Operators
  sum: '∑',
  prod: '∏',
  coprod: '∐',
  int: '∫',
  iint: '∬',
  iiint: '∭',
  oint: '∮',
  bigcup: '⋃',
  bigcap: '⋂',
  bigoplus: '⨁',
  bigotimes: '⨂',
  bigodot: '⨀',
  bigsqcup: '⨆',
  bigvee: '⋁',
  bigwedge: '⋀',

  // Binary Operators & Relations
  times: '×',
  div: '÷',
  cdot: '·',
  cdots: '⋯',
  ldots: '…',
  dots: '…',
  vdots: '⋮',
  ddots: '⋱',
  pm: '±',
  mp: '∓',
  ast: '∗',
  star: '⋆',
  circ: '∘',
  bullet: '∙',
  oplus: '⊕',
  ominus: '⊖',
  otimes: '⊗',
  oslash: '⊘',
  odot: '⊙',
  dagger: '†',
  ddagger: '‡',
  amalg: '⨿',
  cap: '∩',
  cup: '∪',
  uplus: '⊎',
  sqcap: '⊓',
  sqcup: '⊔',
  vee: '∨',
  lor: '∨',
  wedge: '∧',
  land: '∧',
  setminus: '∖',
  wr: '≀',

  leq: '≤',
  le: '≤',
  geq: '≥',
  ge: '≥',
  neq: '≠',
  ne: '≠',
  approx: '≈',
  equiv: '≡',
  cong: '≅',
  sim: '∼',
  simeq: '≃',
  propto: '∝',
  ll: '≪',
  gg: '≫',
  subset: '⊂',
  supset: '⊃',
  subseteq: '⊆',
  supseteq: '⊇',
  nsubseteq: '⊈',
  sqsubseteq: '⊑',
  sqsupseteq: '⊒',
  in: '∈',
  notin: '∉',
  ni: '∋',
  owns: '∋',
  vdash: '⊢',
  dashv: '⊣',
  models: '⊨',
  mid: '∣',
  nmid: '∤',
  parallel: '∥',
  perp: '⊥',
  asymp: '≍',
  triangleq: '≜',
  doteq: '≐',
  prec: '≺',
  succ: '≻',
  preceq: '⪯',
  succeq: '⪰',

  // Arrows
  to: '→',
  rightarrow: '→',
  leftarrow: '←',
  gets: '←',
  leftrightarrow: '↔',
  Rightarrow: '⇒',
  Leftarrow: '⇐',
  Leftrightarrow: '⇔',
  iff: '⟺',
  implies: '⟹',
  impliedby: '⟸',
  mapsto: '↦',
  longmapsto: '⟼',
  longrightarrow: '⟶',
  longleftarrow: '⟵',
  uparrow: '↑',
  downarrow: '↓',
  updownarrow: '↕',
  nearrow: '↗',
  searrow: '↘',
  swarrow: '↙',
  nwarrow: '↖',
  rightharpoonup: '⇀',
  rightharpoondown: '⇁',

  // Logic, Set & Calculus
  forall: '∀',
  exists: '∃',
  nexists: '∄',
  emptyset: '∅',
  varnothing: '∅',
  infty: '∞',
  nabla: '∇',
  partial: '∂',
  ell: 'ℓ',
  hbar: 'ℏ',
  Re: 'ℜ',
  Im: 'ℑ',
  wp: '℘',
  aleph: 'ℵ',
  neg: '¬',
  lnot: '¬',
  top: '⊤',
  bot: '⊥',
  angle: '∠',
  triangle: '△',
  Box: '□',
  square: '□',
  diamond: '⋄',
  checkmark: '✓',
  prime: '′',

  // Delimiters
  langle: '⟨',
  rangle: '⟩',
  lfloor: '⌊',
  rfloor: '⌋',
  lceil: '⌈',
  rceil: '⌉',
  vert: '|',
  Vert: '‖',
  lbrace: '{',
  rbrace: '}',
  backslash: '\\',

  // Named Trig / Log / Limits
  sin: '<span class="math-op-fn">sin</span>',
  cos: '<span class="math-op-fn">cos</span>',
  tan: '<span class="math-op-fn">tan</span>',
  cot: '<span class="math-op-fn">cot</span>',
  sec: '<span class="math-op-fn">sec</span>',
  csc: '<span class="math-op-fn">csc</span>',
  sinh: '<span class="math-op-fn">sinh</span>',
  cosh: '<span class="math-op-fn">cosh</span>',
  tanh: '<span class="math-op-fn">tanh</span>',
  log: '<span class="math-op-fn">log</span>',
  ln: '<span class="math-op-fn">ln</span>',
  exp: '<span class="math-op-fn">exp</span>',
  lim: '<span class="math-op-fn">lim</span>',
  limsup: '<span class="math-op-fn">lim sup</span>',
  liminf: '<span class="math-op-fn">lim inf</span>',
  sup: '<span class="math-op-fn">sup</span>',
  inf: '<span class="math-op-fn">inf</span>',
  max: '<span class="math-op-fn">max</span>',
  min: '<span class="math-op-fn">min</span>',
  argmax: '<span class="math-op-fn">arg max</span>',
  argmin: '<span class="math-op-fn">arg min</span>',
  det: '<span class="math-op-fn">det</span>',
  dim: '<span class="math-op-fn">dim</span>',
  ker: '<span class="math-op-fn">ker</span>',
  deg: '<span class="math-op-fn">deg</span>',
  gcd: '<span class="math-op-fn">gcd</span>',
  Pr: '<span class="math-op-fn">Pr</span>',
  hom: '<span class="math-op-fn">hom</span>',
  arg: '<span class="math-op-fn">arg</span>',
  mod: '<span class="math-op-fn">mod</span>',
  pmod: '<span class="math-op-fn">mod</span>'
};

const BLACKBOARD_BOLD_MAP = {
  A: '𝔸',
  B: '𝔹',
  C: 'ℂ',
  D: '𝔻',
  E: '𝔼',
  F: '𝔽',
  G: '𝔾',
  H: 'ℍ',
  I: '𝕀',
  J: '𝕁',
  K: '𝕂',
  L: '𝕃',
  M: '𝕄',
  N: 'ℕ',
  O: '𝕆',
  P: 'ℙ',
  Q: 'ℚ',
  R: 'ℝ',
  S: '𝕊',
  T: '𝕋',
  U: '𝕌',
  V: '𝕍',
  W: '𝕎',
  X: '𝕏',
  Y: '𝕐',
  Z: 'ℤ',
  1: '𝟙',
  0: '𝟘'
};

const CALLIGRAPHIC_MAP = {
  A: '𝒜',
  B: 'ℬ',
  C: '𝒞',
  D: '𝒟',
  E: 'ℰ',
  F: 'ℱ',
  G: '𝒢',
  H: 'ℋ',
  I: 'ℐ',
  J: '𝒥',
  K: '𝒦',
  L: 'ℒ',
  M: 'ℳ',
  N: '𝒩',
  O: '𝒪',
  P: '𝒫',
  Q: '𝒬',
  R: 'ℛ',
  S: '𝒮',
  T: '𝒯',
  U: '𝒰',
  V: '𝒱',
  W: '𝒲',
  X: '𝒳',
  Y: '𝒴',
  Z: '𝒵'
};

/**
 * Extracts a brace-balanced argument `{...}` starting at index `pos` in `str`.
 * Returns `{ content, endPos }` where `endPos` is the index immediately after `}`.
 */
function readBraceGroup(str, pos) {
  let i = pos;
  while (i < str.length && /\s/.test(str[i])) i++;
  if (str[i] !== '{') {
    return null;
  }
  let depth = 0;
  const start = i + 1;
  for (; i < str.length; i++) {
    if (str[i] === '\\') {
      i++; // skip escaped char
      continue;
    }
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) {
        return { content: str.slice(start, i), endPos: i + 1 };
      }
    }
  }
  return { content: str.slice(start), endPos: str.length };
}

/**
 * Reads a single math atom for superscript/subscript (`{...}`, `\command`, or single character).
 */
function readMathScriptAtom(str, pos) {
  let i = pos;
  while (i < str.length && str[i] === ' ') i++;
  if (i >= str.length) return { content: '', endPos: i };
  if (str[i] === '{') {
    const grp = readBraceGroup(str, i);
    if (grp) return grp;
  }
  if (str[i] === '\\') {
    const m = str.slice(i).match(/^\\([a-zA-Z]+|.)/);
    if (m) {
      const cmdEnd = i + m[0].length;
      if (str[cmdEnd] === '{') {
        const grp = readBraceGroup(str, cmdEnd);
        if (grp) {
          return { content: str.slice(i, grp.endPos), endPos: grp.endPos };
        }
      }
      return { content: m[0], endPos: cmdEnd };
    }
  }
  return { content: str[i], endPos: i + 1 };
}

/**
 * Converts a LaTeX math expression string into structured, publication-grade HTML.
 */
export function renderLatexMathToHtml(latexRaw, displayMode = false) {
  if (!latexRaw) return '';
  let src = String(latexRaw).trim();

  // Extract trailing \tag{...} if present
  let tagHtml = '';
  src = src.replace(/\\tag\*?\{([^{}]+)\}/g, (_, t) => {
    tagHtml = `<span class="math-eq-tag">(${escapeHtml(t.trim())})</span>`;
    return '';
  });

  // Strip outer display wrappers if nested
  src = src
    .replace(/^\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}/i, '')
    .replace(/\\end\{(equation\*?|align\*?|gather\*?|multline\*?)\}$/i, '')
    .trim();

  const bodyHtml = parseLatexFragment(src);
  if (displayMode) {
    return `<span class="math-display-wrap"><span class="math-expr is-display">${bodyHtml}</span>${tagHtml}</span>`;
  }
  return `<span class="math-expr is-inline">${bodyHtml}</span>`;
}

function parseLatexFragment(src) {
  if (!src) return '';
  let out = '';
  let i = 0;

  while (i < src.length) {
    // 1. Handle \begin{env}...\end{env} (cases, aligned, matrix, pmatrix, bmatrix, vmatrix)
    if (src.startsWith('\\begin{', i)) {
      const envMatch = src.slice(i).match(/^\\begin\{([a-zA-Z*]+)\}/);
      if (envMatch) {
        const envName = envMatch[1];
        const endToken = `\\end{${envName}}`;
        const bodyStart = i + envMatch[0].length;
        const endIdx = src.indexOf(endToken, bodyStart);
        if (endIdx !== -1) {
          const envBody = src.slice(bodyStart, endIdx);
          out += renderMathEnvironment(envName, envBody);
          i = endIdx + endToken.length;
          continue;
        }
      }
    }

    const ch = src[i];

    // 2. Handle Subscripts & Superscripts (_ and ^), including simultaneous x_i^2 or x^2_i
    if (ch === '^' || ch === '_') {
      let supContent = null;
      let subContent = null;
      let cursor = i;

      while (cursor < src.length) {
        while (cursor < src.length && src[cursor] === ' ') cursor++;
        if (src[cursor] === '^' && supContent === null) {
          const atom = readMathScriptAtom(src, cursor + 1);
          supContent = atom.content;
          cursor = atom.endPos;
        } else if (src[cursor] === '_' && subContent === null) {
          const atom = readMathScriptAtom(src, cursor + 1);
          subContent = atom.content;
          cursor = atom.endPos;
        } else {
          break;
        }
      }

      if (supContent !== null && subContent !== null) {
        out += `<span class="math-subsup"><sup class="math-sup">${parseLatexFragment(
          supContent
        )}</sup><sub class="math-sub">${parseLatexFragment(subContent)}</sub></span>`;
      } else if (supContent !== null) {
        out += `<sup class="math-sup">${parseLatexFragment(supContent)}</sup>`;
      } else if (subContent !== null) {
        out += `<sub class="math-sub">${parseLatexFragment(subContent)}</sub>`;
      }
      i = cursor;
      continue;
    }

    // 3. Handle Brace Group { ... }
    if (ch === '{') {
      const grp = readBraceGroup(src, i);
      if (grp) {
        out += parseLatexFragment(grp.content);
        i = grp.endPos;
        continue;
      }
    }

    // 4. Handle LaTeX Commands \cmd
    if (ch === '\\') {
      // Escaped symbols: \{, \}, \%, \_, \&, \#, \$, \|, \, \; \: \! \quad \qquad \\
      const next = src[i + 1] || '';
      if (next === '\\') {
        out += '<br class="math-linebreak" />';
        i += 2;
        continue;
      }
      if (next === ',' || next === ';' || next === ':' || next === ' ') {
        out += '&thinsp;';
        i += 2;
        continue;
      }
      if (next === '!') {
        i += 2;
        continue;
      }
      if (next === '|') {
        out += '‖';
        i += 2;
        continue;
      }
      if ('{}%_&#$'.includes(next)) {
        out += escapeHtml(next);
        i += 2;
        continue;
      }

      const cmdMatch = src.slice(i).match(/^\\([a-zA-Z]+)/);
      if (!cmdMatch) {
        i++;
        continue;
      }
      const cmd = cmdMatch[1];
      let cursor = i + cmdMatch[0].length;

      // Ignore sizing prefixes like \left, \right, \big, \Big, \bigg, \Bigg, \limits, \nolimits, \displaystyle, \textstyle
      if (
        cmd === 'left' ||
        cmd === 'right' ||
        cmd === 'middle' ||
        cmd === 'big' ||
        cmd === 'Big' ||
        cmd === 'bigg' ||
        cmd === 'Bigg' ||
        cmd === 'bigl' ||
        cmd === 'bigr' ||
        cmd === 'Bigl' ||
        cmd === 'Bigr' ||
        cmd === 'limits' ||
        cmd === 'nolimits' ||
        cmd === 'displaystyle' ||
        cmd === 'textstyle' ||
        cmd === 'scriptstyle'
      ) {
        if ((cmd === 'left' || cmd === 'right' || cmd === 'middle') && src[cursor] === '.') {
          cursor++; // \left. or \right. invisible delimiter
        }
        i = cursor;
        continue;
      }

      if (cmd === 'quad') {
        out += '&emsp;';
        i = cursor;
        continue;
      }
      if (cmd === 'qquad') {
        out += '&emsp;&emsp;';
        i = cursor;
        continue;
      }

      // Fractions: \frac{a}{b}, \dfrac{a}{b}, \tfrac{a}{b}
      if (cmd === 'frac' || cmd === 'dfrac' || cmd === 'tfrac' || cmd === 'cfrac') {
        const numGrp = readBraceGroup(src, cursor);
        if (numGrp) {
          const denGrp = readBraceGroup(src, numGrp.endPos);
          if (denGrp) {
            out += `<span class="math-frac"><span class="math-num">${parseLatexFragment(
              numGrp.content
            )}</span><span class="math-den">${parseLatexFragment(denGrp.content)}</span></span>`;
            i = denGrp.endPos;
            continue;
          }
        }
      }

      // Binomial: \binom{n}{k}
      if (cmd === 'binom' || cmd === 'dbinom' || cmd === 'tbinom') {
        const topGrp = readBraceGroup(src, cursor);
        if (topGrp) {
          const botGrp = readBraceGroup(src, topGrp.endPos);
          if (botGrp) {
            out += `<span class="math-binom">(<span class="math-frac is-binom"><span class="math-num">${parseLatexFragment(
              topGrp.content
            )}</span><span class="math-den">${parseLatexFragment(botGrp.content)}</span></span>)</span>`;
            i = botGrp.endPos;
            continue;
          }
        }
      }

      // Square root: \sqrt[n]{x} or \sqrt{x}
      if (cmd === 'sqrt') {
        let rootIdxHtml = '';
        if (src[cursor] === '[') {
          const closeBracket = src.indexOf(']', cursor + 1);
          if (closeBracket !== -1) {
            rootIdxHtml = `<sup class="math-sqrt-idx">${parseLatexFragment(
              src.slice(cursor + 1, closeBracket)
            )}</sup>`;
            cursor = closeBracket + 1;
          }
        }
        const radGrp = readBraceGroup(src, cursor);
        if (radGrp) {
          out += `<span class="math-sqrt">${rootIdxHtml}<span class="math-sqrt-sign">√</span><span class="math-sqrt-body">${parseLatexFragment(
            radGrp.content
          )}</span></span>`;
          i = radGrp.endPos;
          continue;
        }
      }

      // Accents / Diacritics: \hat, \widehat, \tilde, \widetilde, \bar, \overline, \underline, \vec, \dot, \ddot
      if (
        cmd === 'hat' ||
        cmd === 'widehat' ||
        cmd === 'tilde' ||
        cmd === 'widetilde' ||
        cmd === 'bar' ||
        cmd === 'overline' ||
        cmd === 'underline' ||
        cmd === 'vec' ||
        cmd === 'overrightarrow' ||
        cmd === 'dot' ||
        cmd === 'ddot'
      ) {
        const grp = readBraceGroup(src, cursor) || readMathScriptAtom(src, cursor);
        if (grp) {
          const inner = parseLatexFragment(grp.content);
          if (cmd === 'overline' || cmd === 'bar') {
            out += `<span class="math-overline">${inner}</span>`;
          } else if (cmd === 'underline') {
            out += `<span class="math-underline">${inner}</span>`;
          } else if (cmd === 'hat' || cmd === 'widehat') {
            out += `<span class="math-accent">${inner}&#x0302;</span>`;
          } else if (cmd === 'tilde' || cmd === 'widetilde') {
            out += `<span class="math-accent">${inner}&#x0303;</span>`;
          } else if (cmd === 'vec' || cmd === 'overrightarrow') {
            out += `<span class="math-accent">${inner}&#x20D7;</span>`;
          } else if (cmd === 'dot') {
            out += `<span class="math-accent">${inner}&#x0307;</span>`;
          } else if (cmd === 'ddot') {
            out += `<span class="math-accent">${inner}&#x0308;</span>`;
          }
          i = grp.endPos;
          continue;
        }
      }

      // \overset{top}{base} and \underset{bot}{base}
      if (cmd === 'overset' || cmd === 'stackrel') {
        const topG = readBraceGroup(src, cursor);
        if (topG) {
          const baseG = readBraceGroup(src, topG.endPos);
          if (baseG) {
            out += `<span class="math-overscript"><span class="math-over-top">${parseLatexFragment(
              topG.content
            )}</span><span class="math-over-base">${parseLatexFragment(baseG.content)}</span></span>`;
            i = baseG.endPos;
            continue;
          }
        }
      }
      if (cmd === 'underset') {
        const botG = readBraceGroup(src, cursor);
        if (botG) {
          const baseG = readBraceGroup(src, botG.endPos);
          if (baseG) {
            out += `<span class="math-underscript"><span class="math-under-base">${parseLatexFragment(
              baseG.content
            )}</span><span class="math-under-bot">${parseLatexFragment(botG.content)}</span></span>`;
            i = baseG.endPos;
            continue;
          }
        }
      }

      // Font commands: \mathbb, \mathcal, \mathbf, \boldsymbol, \bm, \mathrm, \text, \textbf, \textit, \textrm, \mathsf, \mathtt, \operatorname
      if (cmd === 'mathbb' || cmd === 'mathbbm') {
        const grp = readBraceGroup(src, cursor);
        if (grp) {
          const mapped = grp.content
            .trim()
            .split('')
            .map((c) => BLACKBOARD_BOLD_MAP[c] || c)
            .join('');
          out += `<span class="math-bb">${escapeHtml(mapped)}</span>`;
          i = grp.endPos;
          continue;
        }
      }

      if (cmd === 'mathcal' || cmd === 'mathscr') {
        const grp = readBraceGroup(src, cursor);
        if (grp) {
          const mapped = grp.content
            .trim()
            .split('')
            .map((c) => CALLIGRAPHIC_MAP[c] || c)
            .join('');
          out += `<span class="math-cal">${escapeHtml(mapped)}</span>`;
          i = grp.endPos;
          continue;
        }
      }

      if (cmd === 'mathbf' || cmd === 'boldsymbol' || cmd === 'bm' || cmd === 'textbf') {
        const grp = readBraceGroup(src, cursor);
        if (grp) {
          out += `<strong class="math-bf">${parseLatexFragment(grp.content)}</strong>`;
          i = grp.endPos;
          continue;
        }
      }

      if (
        cmd === 'text' ||
        cmd === 'textrm' ||
        cmd === 'mathrm' ||
        cmd === 'operatorname' ||
        cmd === 'mathsf' ||
        cmd === 'mathtt' ||
        cmd === 'textit' ||
        cmd === 'emph' ||
        cmd === 'mbox'
      ) {
        // Handle \operatorname*{...}
        if (src[cursor] === '*') cursor++;
        const grp = readBraceGroup(src, cursor);
        if (grp) {
          const cls =
            cmd === 'mathtt'
              ? 'math-tt'
              : cmd === 'textit' || cmd === 'emph'
              ? 'math-it'
              : cmd === 'operatorname'
              ? 'math-op-fn'
              : 'math-rm';
          out += `<span class="${cls}">${parseLatexFragment(grp.content)}</span>`;
          i = grp.endPos;
          continue;
        }
      }

      // Known Greek letter or symbol
      if (Object.prototype.hasOwnProperty.call(GREEK_AND_SYMBOLS, cmd)) {
        out += GREEK_AND_SYMBOLS[cmd];
        i = cursor;
        continue;
      }

      // Fallback for unknown \command: if followed by {group}, render group; else render command name in roman
      const fallbackGrp = readBraceGroup(src, cursor);
      if (fallbackGrp) {
        out += `<span class="math-rm">${parseLatexFragment(fallbackGrp.content)}</span>`;
        i = fallbackGrp.endPos;
      } else {
        out += `<span class="math-op-fn">${escapeHtml(cmd)}</span>`;
        i = cursor;
      }
      continue;
    }

    // 5. Handle alignment & spacing characters inside math
    if (ch === '&') {
      out += '&ensp;';
      i++;
      continue;
    }
    if (ch === '~') {
      out += '&nbsp;';
      i++;
      continue;
    }
    if (ch === '-') {
      out += '−'; // Proper mathematical minus sign
      i++;
      continue;
    }
    if (ch === '\'') {
      out += '′';
      i++;
      continue;
    }

    // 6. Regular characters (letters in math italic, numbers/punctuation upright)
    if (/[a-zA-Z]/.test(ch)) {
      out += `<var class="math-var">${ch}</var>`;
    } else {
      out += escapeHtml(ch);
    }
    i++;
  }

  return out;
}

function renderMathEnvironment(envName, envBody) {
  const cleanEnv = envName.replace(/\*$/, '').toLowerCase();
  const rows = envBody
    .split(/\\\\/)
    .map((r) => r.trim())
    .filter(Boolean);

  const tableRowsHtml = rows
    .map((row) => {
      const cells = row.split('&').map((c) => `<span class="math-matrix-cell">${parseLatexFragment(c.trim())}</span>`);
      return `<span class="math-matrix-row">${cells.join('')}</span>`;
    })
    .join('');

  const matrixHtml = `<span class="math-matrix">${tableRowsHtml}</span>`;

  if (cleanEnv === 'cases') {
    return `<span class="math-cases"><span class="math-cases-brace">{</span>${matrixHtml}</span>`;
  }
  if (cleanEnv === 'pmatrix') {
    return `<span class="math-delim-wrap">(<span class="math-matrix-inner">${matrixHtml}</span>)</span>`;
  }
  if (cleanEnv === 'bmatrix') {
    return `<span class="math-delim-wrap">[<span class="math-matrix-inner">${matrixHtml}</span>]</span>`;
  }
  if (cleanEnv === 'vmatrix') {
    return `<span class="math-delim-wrap">|<span class="math-matrix-inner">${matrixHtml}</span>|</span>`;
  }
  return matrixHtml;
}

/**
 * Detects whether a block of text on Page 1 is an academic Author & Affiliation header block
 * (e.g. containing `$^{1,*}$`, `$^{1}$University...`, `Corresponding author`, `通讯作者`, or email `@`).
 */
export function isAuthorOrAffiliationBlock(text, blockType = '', pageNum = 1) {
  if (blockType === 'author' || blockType === 'affiliation') return true;
  if (Number(pageNum) > 2 || !text) return false;
  if (blockType === 'heading' || blockType === 'figure' || blockType === 'table' || blockType === 'code') {
    return false;
  }
  const s = String(text);
  // Count author/affiliation superscripts like $^{1}$, $^{1,*}$, $^{2}$, $^{*}$
  const supMatches = s.match(/\$\^\{\s*[0-9*,†‡a-zA-Z]+\s*\}\$/g) || [];
  if (supMatches.length >= 2) return true;
  if (
    supMatches.length >= 1 &&
    (/Corresponding author|通讯作者|University|Institute|Department|School of|大学|学院|研究所/i.test(s) ||
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(s))
  ) {
    return true;
  }
  return false;
}

/**
 * Pre-formats an Author & Affiliation block so that:
 * 1. When affiliations (`$^{1}$俄亥俄大学... $^{2}$南加州大学... $^{*}$通讯作者...`) are concatenated on the same line
 *    after the author names, automatic line breaks are inserted between the author list, affiliations, and corresponding author note.
 */
function formatAuthorAffiliationStructure(rawText) {
  let s = String(rawText || '').trim();
  // Insert line break before affiliation definitions like ` $^{1}$School` or ` $^{1}$俄亥俄`
  // Specifically when `$^{1}$` or `$^{*}$` is preceded by spaces and followed by an institution name/letter (not a comma!)
  s = s.replace(
    /([^\n])\s+(\$\^\{\s*(?:1|\*|†)\s*\}\$\s*(?:Corresponding|通讯作者|[A-Z][a-z]+|[\u4e00-\u9fa5]))/g,
    '$1\n$2'
  );
  // Also separate `$^{*}$Corresponding` or `$^{*}$通讯作者` onto its own line
  s = s.replace(
    /([^\n])\s+(\$\^\{\s*\*\s*\}\$\s*(?:Corresponding|通讯作者))/g,
    '$1\n$2'
  );
  // Separate individual numbered affiliations with a middle dot ` · ` or line break if long
  s = s.replace(
    /([a-zA-Z\u4e00-\u9fa5])\s+(\$\^\{\s*[2-9]\s*\}\$\s*(?:[A-Z][a-z]+|[\u4e00-\u9fa5]))/g,
    '$1 · $2'
  );
  return s;
}

/**
 * Main entry point: Renders a block's text (`original` or `translation`) into safe, rich HTML
 * with full LaTeX inline/display formula support, superscript rendering, and Markdown bold/italic/code.
 */
export function renderRichAcademicHtml(rawText, options = {}) {
  const { blockType = 'paragraph', pageNum = 1 } = options;
  if (!rawText) return '';

  let text = String(rawText).trim();
  if (!text) return '';

  const isAuthor = isAuthorOrAffiliationBlock(text, blockType, pageNum);
  if (isAuthor) {
    text = formatAuthorAffiliationStructure(text);
  }

  // If the entire block is marked `type === 'equation'` and doesn't already wrap in $$...$$ or $...$,
  // render it directly as a display equation (unless it's a mix of prose and $...$).
  if (
    blockType === 'equation' &&
    !text.includes('$') &&
    !text.includes('\\(') &&
    !text.includes('\\[')
  ) {
    return renderLatexMathToHtml(text, true);
  }

  // Tokenize math regions first so HTML escaping and markdown rules don't corrupt LaTeX:
  // Order:
  // 1. Display math: $$...$$ or \[...\] or \begin{equation/align/aligned/gather}...
  // 2. Inline math: $...$ or \(...\)
  const mathTokens = [];
  const putMathToken = (latex, isDisplay) => {
    const id = mathTokens.length;
    // Fast-path: pure affiliation/footnote superscript like `^{1,*}` or `^{2}` or `^{*}`
    const pureSupMatch = !isDisplay && latex.trim().match(/^\^\{\s*([0-9*,†‡a-zA-Z\s-]+)\s*\}$/);
    if (pureSupMatch) {
      mathTokens.push(`<sup class="academic-sup">${escapeHtml(pureSupMatch[1].trim())}</sup>`);
    } else {
      mathTokens.push(renderLatexMathToHtml(latex, isDisplay));
    }
    return `\uE000MATH_${id}\uE001`;
  };

  // 1a. $$ ... $$
  text = text.replace(/\$\$([\s\S]+?)\$\$/g, (_, inner) => putMathToken(inner, true));

  // 1b. \[ ... \]
  text = text.replace(/\\\[([\s\S]+?)\\\]/g, (_, inner) => putMathToken(inner, true));

  // 1c. Standalone \begin{equation|align|aligned|gather|multline} ... \end{...} outside $...$
  text = text.replace(
    /\\begin\{(equation\*?|align\*?|aligned|gather\*?|multline\*?)\}([\s\S]+?)\\end\{\1\}/g,
    (full) => putMathToken(full, true)
  );

  // 2a. \( ... \)
  text = text.replace(/\\\(([\s\S]+?)\\\)/g, (_, inner) => putMathToken(inner, false));

  // 2b. Inline $ ... $ (non-empty, not crossing paragraph breaks, avoiding currency like "$100 and $200")
  text = text.replace(/\$([^\n$]+?)\$/g, (full, inner) => {
    const trimmed = inner.trim();
    if (!trimmed) return full;
    // Avoid false-positive currency matches like "$100 ... $200" where inner starts with a digit and has spaces/words without math symbols
    if (/^\d+(?:[.,]\d+)?\s+[a-zA-Z]{2,}/.test(trimmed) && !/[\\^_{}=<>+\-*/]/.test(trimmed)) {
      return full;
    }
    return putMathToken(trimmed, false);
  });

  // 2c. Catch bare LaTeX superscripts/subscripts like Word^{1,*} or x_{i} that Gemini occasionally outputs without $...$
  text = text.replace(/\^\{([0-9*,†‡a-zA-Z+\-]{1,12})\}/g, (_, sup) =>
    putMathToken(`^{${sup}}`, false)
  );

  // Escape HTML on the non-math prose
  let html = escapeHtml(text);

  // Lightweight inline Markdown formatting (**bold**, `code`)
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/`([^`\n]+)`/g, '<code class="inline-code-chip">$1</code>');

  // Convert newlines to <br />
  html = html.replace(/\n/g, '<br />');

  // Restore math tokens
  html = html.replace(/\uE000MATH_(\d+)\uE001/g, (_, idx) => mathTokens[Number(idx)] || '');

  return html;
}
