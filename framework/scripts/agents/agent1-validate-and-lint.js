/**
 * AGENT 1 - VALIDATE AND LINT
 *
 * PURPOSE:
 *   Replaces the 3-persona AI review with a deterministic two-pass check on the
 *   test cases JSON produced by Claude (Agent 1).
 *
 *   Pass 1 - VALIDATE (hard errors, exit 1):
 *     Schema/contract checks. If any fail, the run is broken; do not write Excel.
 *       - Required fields non-empty (title, steps, expectedResult)
 *       - Priority in {Critical, High, Medium, Low}
 *       - Unique IDs, unique normalized titles
 *
 *   Pass 2 - LINT (soft warnings, exit 2 if any, exit 0 if clean):
 *     Quality checks. Findings are written to a JSON file so Claude can read
 *     them and fix ONLY the flagged test cases (surgical correction loop).
 *       - Vague verbs and vague step text
 *       - Short / underspecified steps
 *       - Vague expected results
 *       - Generic test data placeholders
 *       - Steps mention data that the test data field doesn't include
 *       - acRef doesn't substring-match any AC line (when AC provided)
 *       - Duplicate normalized titles (already an error, surfaced at lint level too for context)
 *
 * USAGE:
 *   node scripts/agents/agent1-validate-and-lint.js --inputFile=output/temp/22846-testcases.json
 *
 *   Standalone CLI:
 *     - exit 0  - clean (no errors, no warnings)
 *     - exit 1  - validation errors (do NOT proceed to Excel write)
 *     - exit 2  - lint warnings only (Claude should fix flagged TCs and re-run)
 *
 *   As a library (used by agent1-generate-test-cases.js):
 *     const { validateTestCases, lintTestCases } = require('./agent1-validate-and-lint');
 */

const fs = require('fs');
const path = require('path');

// =============================================================================
// VALIDATION (hard errors)
// =============================================================================

const VALID_PRIORITIES = ['Critical', 'High', 'Medium', 'Low'];

function normalizeTitle(t) {
  return (t || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Top-level contract checks on the testcases.json input (not the testCases array itself).
// Added per ticket #35122: the BLOCKING automation-repo scan in STEP 4.5 must leave a
// trace in the JSON or downstream Agent 3 produces [NEW]-heavy feature files.
function validateInput(input) {
  const errors = [];

  if (!input || typeof input !== 'object') {
    errors.push({ tcId: 'GLOBAL', rule: 'shape', field: 'root', message: 'Input is not a JSON object' });
    return errors;
  }

  // automationRepoReferences must exist as an array. Empty is OK only when paired
  // with automationRepoScanResult: "no-match" - proves the scan ran and found nothing.
  if (input.automationRepoReferences === undefined) {
    errors.push({
      tcId: 'GLOBAL',
      rule: 'missing-automation-repo-scan',
      field: 'automationRepoReferences',
      message: 'Top-level "automationRepoReferences" array is missing - Agent 1 must perform the canonical-step-text scan per STEP 4.5 (BLOCKING). If no .feature file matched, set automationRepoReferences=[] AND automationRepoScanResult="no-match" with a reason.'
    });
  } else if (!Array.isArray(input.automationRepoReferences)) {
    errors.push({
      tcId: 'GLOBAL',
      rule: 'invalid-automation-repo-scan',
      field: 'automationRepoReferences',
      message: '"automationRepoReferences" must be an array (use [] when no .feature file matched).'
    });
  } else if (input.automationRepoReferences.length === 0 && !input.automationRepoScanResult) {
    errors.push({
      tcId: 'GLOBAL',
      rule: 'incomplete-automation-repo-scan',
      field: 'automationRepoScanResult',
      message: 'automationRepoReferences is empty but no automationRepoScanResult was recorded. Set automationRepoScanResult="no-match" with automationRepoScanReason explaining the keyword list and why nothing matched.'
    });
  }

  return errors;
}

function validateTestCases(testCases) {
  const errors = [];

  if (!Array.isArray(testCases)) {
    errors.push({ rule: 'shape', message: 'testCases must be an array' });
    return errors;
  }

  if (testCases.length === 0) {
    errors.push({ rule: 'empty', message: 'testCases array is empty - nothing to write' });
    return errors;
  }

  const seenIds = new Map();
  const seenTitles = new Map();

  testCases.forEach((tc, idx) => {
    const tcLabel = tc.id || `row ${idx + 1}`;

    // Required non-empty fields
    if (!tc.title || !tc.title.trim()) {
      errors.push({ tcId: tcLabel, rule: 'missing-title', field: 'title', message: 'Title is empty or missing' });
    }
    if (!tc.steps || !tc.steps.trim()) {
      errors.push({ tcId: tcLabel, rule: 'missing-steps', field: 'steps', message: 'Test steps are empty or missing' });
    }
    if (!tc.expectedResult || !tc.expectedResult.trim()) {
      errors.push({ tcId: tcLabel, rule: 'missing-expected', field: 'expectedResult', message: 'Expected result is empty or missing' });
    }

    // Priority enum
    if (tc.priority && !VALID_PRIORITIES.includes(tc.priority)) {
      errors.push({
        tcId: tcLabel,
        rule: 'invalid-priority',
        field: 'priority',
        message: `Priority "${tc.priority}" is not one of ${VALID_PRIORITIES.join(', ')}`
      });
    }

    // Unique IDs
    if (tc.id) {
      if (seenIds.has(tc.id)) {
        errors.push({
          tcId: tc.id,
          rule: 'duplicate-id',
          field: 'id',
          message: `Duplicate ID - also used at row ${seenIds.get(tc.id) + 1}`
        });
      } else {
        seenIds.set(tc.id, idx);
      }
    }

    // Unique normalized titles
    if (tc.title) {
      const norm = normalizeTitle(tc.title);
      if (seenTitles.has(norm)) {
        errors.push({
          tcId: tcLabel,
          rule: 'duplicate-title',
          field: 'title',
          message: `Duplicate title - also used at ${seenTitles.get(norm).label}`
        });
      } else {
        seenTitles.set(norm, { idx, label: tcLabel });
      }
    }
  });

  return errors;
}

// =============================================================================
// LINT (soft warnings)
// =============================================================================

// Words that, when used alone or near-alone in a step, mark it as vague.
// Caught when the step is short OR the verb has no specific object.
const VAGUE_VERBS = ['verify', 'check', 'ensure', 'validate', 'confirm', 'test'];

// Phrases that are inherently vague regardless of surrounding context.
const VAGUE_PHRASES = [
  'perform the action',
  'do the thing',
  'as expected',
  'works correctly',
  'works as expected',
  'appropriate behavior',
  'appropriate response',
  'should work',
  'should be successful',
  'no errors',
  'no issues',
  'looks correct',
  'displays correctly',
  'behaves correctly',
  'functionality works'
];

// Generic / placeholder data that signals the LLM didn't think about real data.
const PLACEHOLDER_TEST_DATA = [
  'test data',
  'sample value',
  'sample data',
  'example data',
  'example value',
  'user@example.com',
  'test@test.com',
  'foo@bar.com',
  'placeholder',
  'lorem ipsum',
  'xxxx',
  'abcd1234'
];

// Tokens in step text that imply test data is required (so the testData field
// shouldn't be empty).
const DATA_KEYWORDS = [
  'enter email',
  'enter password',
  'enter username',
  'enter store',
  'enter order',
  'enter patient',
  'enter customer',
  'enter phone',
  'select store',
  'select environment',
  'use credentials',
  'login as',
  'log in as'
];

const SHORT_STEP_MIN_CHARS = 20;

// ---- Atomicity rules (Gaps 1, 2, 4) ----

// Action verbs we expect at the START of a single atomic step. Multiple of these
// in one step (with conjunctions between them) is the compound-step smell.
const ATOMIC_ACTION_VERBS = [
  'click', 'select', 'enter', 'type', 'fill', 'choose', 'pick', 'press', 'tap',
  'hit', 'add', 'remove', 'delete', 'create', 'edit', 'update', 'save', 'cancel',
  'submit', 'open', 'close', 'navigate', 'search', 'login', 'logout', 'verify',
  'check', 'confirm', 'validate', 'expand', 'collapse', 'scroll', 'go', 'switch',
  'apply', 'upload', 'download', 'get', 'launch', 'set', 'change'
];

// Conjunctions between actions that indicate a compound step.
const COMPOUND_CONJUNCTIONS = [
  /\bclick\s+.+\band\s+(?:click|select|enter|type|fill|choose|verify|add|navigate)\b/i,
  /\bselect\s+.+\band\s+(?:click|select|enter|type|fill|choose|verify|add|navigate)\b/i,
  /\benter\s+.+\band\s+(?:click|select|enter|type|fill|choose|verify|add|navigate)\b/i,
  /\bclick\s+.+\bthen\s+(?:click|select|enter|type|fill|choose|verify|add|navigate)\b/i,
  /\b(?:click|select|enter)\s+.+\s+->\s+\w+/i,
  /\b(?:click|select|enter)\s+.+\s+→\s+\w+/i,
];

// Scenario-type detection by Subject / tags. Higher minimums for end-to-end flows.
const SCENARIO_TYPE_MIN_STEPS = [
  { match: /\b(order|cart|checkout|payment|remake|exchange|warranty|loyalty|refund|invoice)\b/i, type: 'order',     minSteps: 15 },
  { match: /\b(scheduler|appointment|booking)\b/i,                                                  type: 'scheduler', minSteps: 10 },
  { match: /\b(patient|demographics|profile|sign[\s-]?in)\b/i,                                       type: 'patient',   minSteps: 8 },
  { match: /\b(occ|operations\s+command\s+center|closing|cc\s*report)\b/i,                          type: 'occ',       minSteps: 10 },
  { match: /\b(insurance|carrier|plan|copay)\b/i,                                                    type: 'insurance', minSteps: 10 },
  { match: /\b(clinic|exam|prescription)\b/i,                                                        type: 'clinical',  minSteps: 10 },
];
const DEFAULT_MIN_STEPS = 4; // applies when nothing matches above

// ---- Domain knowledge loader (Gap 3) ----

// Pulls atomic step patterns from steering/step-library.md.
// The file is structured as numbered sections with fenced code blocks containing
// one approved step pattern per line. We extract those lines as the reference set.
let _dkCache = null;
function loadDomainKnowledgeSteps() {
  if (_dkCache) return _dkCache;
  const path = require('path');
  const candidates = [
    path.join(__dirname, '..', '..', 'steering', 'step-library.md'),
    path.join(__dirname, '..', '..', 'steering', 'step-library.md'),
  ];
  let raw = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) { raw = fs.readFileSync(p, 'utf8'); break; }
  }
  if (!raw) { _dkCache = []; return _dkCache; }

  // Extract every line inside fenced code blocks (```...```) that looks like a
  // Gherkin step (starts with an action verb or "I " or a Gherkin keyword).
  const patterns = [];
  const fence = /```[\s\S]*?```/g;
  let m;
  while ((m = fence.exec(raw)) !== null) {
    const block = m[0].replace(/```[a-z]*\n?/g, '').replace(/```$/g, '');
    block.split('\n').forEach(line => {
      const trimmed = line.replace(/^\s*\|.*\|\s*$/, '').trim(); // skip table rows
      if (!trimmed) return;
      // Step lines start with an action verb, "I ", or Gherkin keyword
      if (/^(I\s|Given\s|When\s|Then\s|And\s|But\s|Verify\s|Launch\s)/i.test(trimmed)) {
        patterns.push(trimmed);
      }
    });
  }
  _dkCache = patterns;
  return _dkCache;
}

function detectScenarioType(tc) {
  const haystack = [tc.subject || '', tc.tags || '', tc.title || ''].join(' ');
  for (const entry of SCENARIO_TYPE_MIN_STEPS) {
    if (entry.match.test(haystack)) return entry;
  }
  return { type: 'generic', minSteps: DEFAULT_MIN_STEPS };
}

// Count discrete action verbs in a single step line.
function countActionVerbs(line) {
  const lower = (line || '').toLowerCase();
  let count = 0;
  for (const v of ATOMIC_ACTION_VERBS) {
    // Whole-word match; allow multiple matches per verb if the verb appears more than once
    const re = new RegExp('\\b' + v + '\\b', 'g');
    const matches = lower.match(re);
    if (matches) count += matches.length;
  }
  return count;
}

function tokenize(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2);
}

// Rough fuzzy score between a step and the closest domain-knowledge pattern.
// Used by Gap 3 (per-step warning) and Gap 5 (aggregate pre-flight reuse).
// Use Map (not WeakMap) - keys are strings, which WeakMap doesn't accept.
const _dkTokenSets = new Map();
function bestDomainKnowledgeScore(stepText, dkPatterns) {
  if (!stepText || !dkPatterns || dkPatterns.length === 0) return 0;
  const stepTokens = new Set(tokenize(stepText));
  if (stepTokens.size === 0) return 0;
  let best = 0;
  for (const pattern of dkPatterns) {
    let patternTokens = _dkTokenSets.get(pattern);
    if (!patternTokens) {
      patternTokens = new Set(tokenize(pattern));
      _dkTokenSets.set(pattern, patternTokens);
    }
    if (patternTokens.size === 0) continue;
    const intersection = [...stepTokens].filter(t => patternTokens.has(t)).length;
    const score = intersection / Math.min(stepTokens.size, patternTokens.size);
    if (score > best) best = score;
    if (best >= 0.95) break; // strong match, no need to scan further
  }
  return best;
}

function lintTestCases(testCases, workItem, automationRepoReferences, clarificationQuestions) {
  const findings = [];
  automationRepoReferences = automationRepoReferences || [];
  clarificationQuestions = clarificationQuestions || [];

  // Build AC token set once for unmapped-acref detection
  let acLines = [];
  if (workItem && workItem.acceptanceCriteria) {
    acLines = workItem.acceptanceCriteria
      .split(/\r?\n/)
      .map(l => l.trim())
      .filter(l => l.length > 0);
  }
  const acTokenSets = acLines.map(l => new Set(tokenize(l)));

  // Domain-knowledge patterns (Gap 3 + Gap 5). Loaded once per lint run.
  const dkPatterns = loadDomainKnowledgeSteps();

  testCases.forEach((tc, idx) => {
    const tcId = tc.id || `row ${idx + 1}`;

    // ---- Steps: vague verbs / phrases / short ----
    const stepLines = (tc.steps || '')
      .split(/\r?\n/)
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length > 0);

    // Gap 2: Min step count by scenario type. Catches "Create a remake DYOF order"
    // style one-liners where the test case has dramatically fewer steps than the
    // end-to-end flow it claims to verify.
    const scenarioInfo = detectScenarioType(tc);
    if (stepLines.length < scenarioInfo.minSteps) {
      findings.push({
        tcId,
        field: 'steps',
        rule: 'too-few-steps',
        snippet: `${stepLines.length} step(s) found`,
        message: `Has ${stepLines.length} step(s) but ${scenarioInfo.type} scenarios need at least ${scenarioInfo.minSteps}. Likely over-summarized - decompose into atomic UI actions.`
      });
    }

    stepLines.forEach((line, lineIdx) => {
      const lower = line.toLowerCase();

      // Vague phrase match
      const phraseHit = VAGUE_PHRASES.find(p => lower.includes(p));
      if (phraseHit) {
        findings.push({
          tcId,
          field: 'steps',
          rule: 'vague-step',
          snippet: line.substring(0, 120),
          message: `Step ${lineIdx + 1} contains vague phrase: "${phraseHit}"`
        });
      }

      // Vague verb alone (e.g. step is just "Verify the result" with no specific object)
      // Trigger: contains a vague verb AND step is < 40 chars AND does not contain a quoted/parenthetical specific
      const hasVagueVerb = VAGUE_VERBS.some(v => new RegExp(`\\b${v}\\b`, 'i').test(line));
      const looksGeneric = line.length < 40 && !/["'(]|\d/.test(line);
      if (hasVagueVerb && looksGeneric && !phraseHit) {
        findings.push({
          tcId,
          field: 'steps',
          rule: 'vague-verb',
          snippet: line,
          message: `Step ${lineIdx + 1} uses a vague verb without a specific object - make it concrete`
        });
      }

      // Short step
      if (line.length > 0 && line.length < SHORT_STEP_MIN_CHARS) {
        findings.push({
          tcId,
          field: 'steps',
          rule: 'short-step',
          snippet: line,
          message: `Step ${lineIdx + 1} is only ${line.length} chars - likely incomplete`
        });
      }

      // Gap 1: Compound step - multiple atomic actions glued together by conjunctions.
      // Examples flagged: "Click X and select Y", "Add patient then click Create",
      // "Click X -> verify Y". These should be split into individual step lines.
      const compoundHit = COMPOUND_CONJUNCTIONS.find(re => re.test(line));
      if (compoundHit) {
        findings.push({
          tcId,
          field: 'steps',
          rule: 'compound-step',
          snippet: line.substring(0, 120),
          message: `Step ${lineIdx + 1} contains multiple actions - split into atomic step lines (one UI action per line)`
        });
      }

      // Gap 1 (continued): Count action verbs. Two+ atomic verbs in one short line
      // usually means a compound step even if no obvious conjunction matched.
      const verbCount = countActionVerbs(line);
      if (verbCount >= 3 && line.length < 200 && !compoundHit) {
        findings.push({
          tcId,
          field: 'steps',
          rule: 'compound-step',
          snippet: line.substring(0, 120),
          message: `Step ${lineIdx + 1} has ${verbCount} action verbs - likely multiple actions in one line, split them out`
        });
      }

      // Gap 4: Prose block - multiple sentences or internal numbering inside one step.
      // Examples flagged: "Click Add Patient. Fill details. Click Create." OR
      // "1. Click X 2. Click Y 3. Verify Z" stuffed into one line.
      const hasMultipleSentences = /[.!?]\s+[A-Z]/.test(line) && line.length > 60;
      const hasInternalNumbering = /\b\d+[\.\)]\s+\S.*\b\d+[\.\)]\s+\S/.test(line);
      if (hasMultipleSentences || hasInternalNumbering) {
        findings.push({
          tcId,
          field: 'steps',
          rule: 'prose-block',
          snippet: line.substring(0, 120),
          message: `Step ${lineIdx + 1} contains a prose block (multiple sentences or internal numbering) - break each action into its own line`
        });
      }

      // Per ticket #35122 verification-atomicity rule: catch compound verification
      // steps. Atomic Then/And verifications must each assert ONE field/value.
      //
      // Patterns flagged:
      //   - "I verify X, Y, Z" with 2+ comma-separated targets in a parenthetical list
      //     e.g. "I verify all discount amounts (Insurance, Email Promo, Subscribe & Save) display..."
      //   - "I verify X and verify Y" (two verify verbs)
      //   - "I verify X and Y and Z" (3+ assertions joined by "and")
      const isVerificationStep = /\b(verify|verifies|verifying|check|ensure|validate|confirm|assert)\b/i.test(line);
      if (isVerificationStep) {
        // (a) Parenthetical comma-list of 2+ items inside a verify step
        const parenList = line.match(/\(([^)]+)\)/);
        if (parenList) {
          const items = parenList[1].split(/\s*,\s*/).filter(t => t.length > 0);
          if (items.length >= 2) {
            findings.push({
              tcId,
              field: 'steps',
              rule: 'compound-verification-step',
              snippet: line.substring(0, 120),
              message: `Step ${lineIdx + 1} bundles ${items.length} verification targets (${items.join(', ').substring(0, 80)}) into one step. Split into ${items.length} atomic Then/And steps - one per target.`
            });
          }
        }
        // (b) Multiple verify verbs in one line
        const verifyVerbCount = (line.match(/\b(verify|verifies|verifying|check|ensure|validate|confirm|assert)\b/gi) || []).length;
        if (verifyVerbCount >= 2) {
          findings.push({
            tcId,
            field: 'steps',
            rule: 'compound-verification-step',
            snippet: line.substring(0, 120),
            message: `Step ${lineIdx + 1} contains ${verifyVerbCount} verification verbs - split into atomic Then/And steps, one assertion per step.`
          });
        }
        // (c) "and ... and ..." pattern joining 3+ phrases inside a verify step
        const trailingAfterVerify = line.replace(/^.*?\b(verify|check|ensure|validate|confirm|assert)\b\s+/i, '');
        const andSegments = trailingAfterVerify.split(/\s+\band\b\s+/i);
        if (andSegments.length >= 3) {
          findings.push({
            tcId,
            field: 'steps',
            rule: 'compound-verification-step',
            snippet: line.substring(0, 120),
            message: `Step ${lineIdx + 1} chains ${andSegments.length} clauses with "and" inside a verification - split into atomic Then/And steps.`
          });
        }
      }

      // Gap 3: Domain-knowledge alignment. If the step text doesn't fuzzy-match any
      // approved pattern from steering/step-library.md, the
      // step will likely produce a [NEW] marker when Agent 3 processes it.
      // Threshold 0.30 is deliberately low - we want a wide net, not nitpicks.
      if (dkPatterns.length > 0 && line.length >= SHORT_STEP_MIN_CHARS) {
        const dkScore = bestDomainKnowledgeScore(line, dkPatterns);
        if (dkScore < 0.30) {
          findings.push({
            tcId,
            field: 'steps',
            rule: 'step-outside-domain-knowledge',
            snippet: line.substring(0, 120),
            message: `Step ${lineIdx + 1} doesn't match any pattern in steering/step-library.md (best fuzzy ${Math.round(dkScore * 100)}%) - Agent 3 will likely emit [NEW] for this step. Rewrite using an existing atomic pattern.`
          });
        }
      }
    });

    // ---- Expected result: vague phrases ----
    const erText = (tc.expectedResult || '').trim();
    const erLower = erText.toLowerCase();
    const erVague = VAGUE_PHRASES.find(p => erLower.includes(p));
    if (erVague) {
      findings.push({
        tcId,
        field: 'expectedResult',
        rule: 'vague-expected',
        snippet: erText.substring(0, 120),
        message: `Expected result contains vague phrase: "${erVague}"`
      });
    }
    if (erText.length > 0 && erText.length < SHORT_STEP_MIN_CHARS) {
      findings.push({
        tcId,
        field: 'expectedResult',
        rule: 'short-expected',
        snippet: erText,
        message: `Expected result is only ${erText.length} chars - needs measurable detail`
      });
    }

    // Per ticket #35122 verification-atomicity rule: expectedResult must be a
    // ONE-LINE high-level summary. Multiple assertions belong as atomic Then/And
    // steps in the `steps` field. Multi-sentence expectedResult blocks become
    // Then [NEW] stubs in Agent 3, hiding multiple assertions behind one marker.
    //
    // Flag if expectedResult contains 2+ sentences (period followed by capital
    // letter starting a new clause).
    if (erText.length > 0) {
      const sentenceMatches = erText.match(/[.!?]\s+[A-Z]/g) || [];
      const sentenceCount = sentenceMatches.length + 1;
      if (sentenceCount >= 2 && erText.length > 80) {
        findings.push({
          tcId,
          field: 'expectedResult',
          rule: 'prose-expected-result',
          snippet: erText.substring(0, 120),
          message: `Expected result contains ${sentenceCount} sentences (${erText.length} chars). Move each assertion into an atomic Then/And step in "steps", and leave expectedResult as a ONE-LINE high-level summary.`
        });
      }
    }

    // ---- Test data: placeholders + missing when steps imply data ----
    const tdText = (tc.testData || '').trim();
    const tdLower = tdText.toLowerCase();
    const tdPlaceholder = PLACEHOLDER_TEST_DATA.find(p => tdLower.includes(p));
    if (tdPlaceholder) {
      findings.push({
        tcId,
        field: 'testData',
        rule: 'placeholder-data',
        snippet: tdText.substring(0, 120),
        message: `Test data uses placeholder: "${tdPlaceholder}" - provide realistic value`
      });
    }
    const stepsLower = (tc.steps || '').toLowerCase();
    const dataNeeded = DATA_KEYWORDS.find(k => stepsLower.includes(k));
    if (dataNeeded && tdText.length === 0) {
      findings.push({
        tcId,
        field: 'testData',
        rule: 'missing-test-data',
        snippet: dataNeeded,
        message: `Steps mention "${dataNeeded}" but test data field is empty`
      });
    }

    // ---- acRef unmapped (only when AC is available) ----
    const acRef = (tc.acRef || '').trim();
    if (acTokenSets.length > 0 && acRef) {
      const refTokens = new Set(tokenize(acRef));
      let bestOverlap = 0;
      for (const acTokens of acTokenSets) {
        if (refTokens.size === 0 || acTokens.size === 0) continue;
        const intersection = [...refTokens].filter(t => acTokens.has(t)).length;
        const smaller = Math.min(refTokens.size, acTokens.size);
        const ratio = intersection / smaller;
        if (ratio > bestOverlap) bestOverlap = ratio;
      }
      // Suspicious mapping: < 30% token overlap with the best AC line
      if (bestOverlap < 0.3) {
        findings.push({
          tcId,
          field: 'acRef',
          rule: 'unmapped-acref',
          snippet: acRef.substring(0, 120),
          message: `acRef does not closely match any AC line (best token overlap ${Math.round(bestOverlap * 100)}%)`
        });
      }
    }

    // ---- Missing subject (warning, not error) ----
    if (!tc.subject || !tc.subject.trim()) {
      findings.push({
        tcId,
        field: 'subject',
        rule: 'missing-subject',
        snippet: '',
        message: 'Subject is empty - Agent 2 will dump this TC into the root suite (no functional grouping)'
      });
    }
  });

  // ===========================================================================
  // SUITE-LEVEL RULES (run once across the whole testCases[] + source context)
  // ===========================================================================

  // Rule: missing-per-section-tc - added per ticket #36251
  // When automationRepoReferences[].reusedPatterns[] reveals per-section validation
  // scenarios (N sections), testCases[] should have >= N distinct subjects.
  // Otherwise the multi-section form has zero per-section edit-and-persist TCs and
  // the canonical structural pattern was not mirrored.
  const perSectionPatterns = automationRepoReferences
    .flatMap(ref => (ref && Array.isArray(ref.reusedPatterns)) ? ref.reusedPatterns : [])
    .filter(p => typeof p === 'string' && /validate\s+all\s+fields\s+under|validate\s+\w+\s+step\b/i.test(p));
  if (perSectionPatterns.length >= 2) {
    const distinctSubjects = new Set(
      testCases.map(tc => (tc.subject || '').trim().toLowerCase()).filter(Boolean)
    );
    if (distinctSubjects.size < perSectionPatterns.length) {
      findings.push({
        tcId: 'GLOBAL',
        field: 'subject',
        rule: 'missing-per-section-tc',
        snippet: `${perSectionPatterns.length} per-section pattern(s) in automationRepoReferences vs ${distinctSubjects.size} distinct subject(s) in testCases`,
        message: `automationRepoReferences hints at ${perSectionPatterns.length} per-section validation scenarios (canonical "Validate All Fields under <X>" / "Validate <X> Step" pattern) but testCases[] only covers ${distinctSubjects.size} distinct subject(s). Generate one per-section TC per section (load → edit every field → save → re-open → verify persistence + section-scoped audit log entry). Set each TC's subject to the section name so Agent 2 groups them into dedicated Test Suites.`
      });
    }
  }

  // Rule: proposed-scope-reduction-dropped - added per ticket #36252
  // Detect PROPOSED (conditional voice) scope-reduction proposals in comments and
  // warn if the affected target keyword appears in NO TC acRef AND NO
  // clarificationQuestion. Catches the silent-drop pattern where Agent 1 acts on a
  // proposal as if it were executed.
  const CONDITIONAL_MARKERS = /\b(?:if\s+(?:you|we|i|they)\b|we\s+(?:could|can|might|should|would)\b|i\s+suggest\b|shall\s+we\b|what\s+if\s+we\b|let'?s\s+(?:drop|remove|skip|cut)\b)/i;
  const REMOVAL_TARGET_REGEX = /\b(?:remove|drop|skip|cut|hard[- ]?code|replace)\s+(?:the\s+|a\s+|all\s+|any\s+|some\s+)?([^.!?\n,;:]{3,80})/gi;
  // Filter out auto-generated agent comments (Agent 2/3 post audit comments that
  // mention "removed"/"created" in non-scope contexts). These start with known markers.
  const AGENT_COMMENT_MARKERS = /(?:✅\s*Test\s+Plan|✅\s*Test\s+Cases|🤖\s*AI\s+Agent|Agent\s+\d\s+(?:created|generated|pushed))/i;

  const comments = (workItem && Array.isArray(workItem.comments)) ? workItem.comments : [];
  const acRefText = testCases.map(tc => (tc.acRef || '').toLowerCase()).join(' | ');
  const clarifText = clarificationQuestions
    .map(q => `${q.question || ''} ${q.reason || ''}`.toLowerCase())
    .join(' | ');

  const proposedFlagged = new Set(); // dedupe per (author + target) pair
  for (const c of comments) {
    const body = ((c && (c.text || c.body)) || '').toString();
    if (!body || AGENT_COMMENT_MARKERS.test(body)) continue;

    // Sentence-by-sentence scan - a comment may have both proposed and executed
    // statements; only the proposed sentences should trigger the rule.
    const sentences = body.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (!CONDITIONAL_MARKERS.test(sentence)) continue;

      REMOVAL_TARGET_REGEX.lastIndex = 0;
      let m;
      while ((m = REMOVAL_TARGET_REGEX.exec(sentence)) !== null) {
        const target = (m[1] || '').trim().toLowerCase();
        if (!target) continue;
        const targetTokens = target.split(/\s+/).filter(t => t.length >= 4 && !/^(from|with|into|onto|that|this|these|those|will|when|what|where|which|been|have|here|there)$/i.test(t));
        if (targetTokens.length === 0) continue;

        const hitAcRef = targetTokens.some(t => acRefText.includes(t));
        const hitClarif = targetTokens.some(t => clarifText.includes(t));
        if (hitAcRef || hitClarif) continue;

        const dedupeKey = `${(c.author || 'unknown').toLowerCase()}::${targetTokens.slice(0, 3).join('-')}`;
        if (proposedFlagged.has(dedupeKey)) continue;
        proposedFlagged.add(dedupeKey);

        findings.push({
          tcId: 'GLOBAL',
          field: 'comments',
          rule: 'proposed-scope-reduction-dropped',
          snippet: target.substring(0, 100),
          message: `Comment by ${c.author || 'unknown'} on ${c.date || '?'} proposes (does not execute) a scope reduction touching "${target.substring(0, 60)}", but no TC acRef and no clarificationQuestion references it. Treat PROPOSED scope reductions ("if you...", "we could...", "I suggest...") as questions, not executed decisions - keep the AC in scope and add a clarificationQuestion citing this comment so the human reviewer decides.`
        });
        break; // one finding per sentence is enough
      }
    }
  }

  return findings;
}

// Figma traceability: when a Figma design was fetched, every UI-type TC must cite
// the frame it was derived from (tc.figmaRef), and the frame must exist in the
// fetched scope. Prevents "Figma-based" UI tests that were really guessed.
const UI_CATEGORY_RE = /\b(ui|ux|usability|visual|display|layout)\b/i;

function lintFigmaRefs(testCases, figmaFrames) {
  const findings = [];
  if (!figmaFrames || figmaFrames.length === 0) return findings;
  const frameIds = new Set(figmaFrames.map(f => String(f.id)));
  const nameCounts = {};
  figmaFrames.forEach(f => {
    const n = String(f.name).trim().toLowerCase();
    nameCounts[n] = (nameCounts[n] || 0) + 1;
  });
  const frameNames = new Set(Object.keys(nameCounts));

  testCases.forEach((tc, idx) => {
    const tcId = tc.id || `row ${idx + 1}`;
    const refs = (Array.isArray(tc.figmaRef) ? tc.figmaRef : String(tc.figmaRef || '').split(/[;,]/))
      .map(r => r.trim())
      .filter(Boolean);
    const isUi = UI_CATEGORY_RE.test(tc.category || tc.type || '');

    if (isUi && refs.length === 0) {
      findings.push({
        tcId,
        field: 'figmaRef',
        rule: 'ui-tc-missing-figma-ref',
        snippet: (tc.title || '').substring(0, 100),
        message: `UI test case has no figmaRef. A Figma design was fetched - set figmaRef to the frame name(s) this TC verifies (see output/temp/<id>-figma.json frames[].name), or recategorise if it is not UI-derived.`
      });
    }
    refs.forEach(r => {
      if (frameIds.has(r)) return; // frame id - always unambiguous
      const key = r.toLowerCase();
      if (!frameNames.has(key)) {
        findings.push({
          tcId,
          field: 'figmaRef',
          rule: 'figma-ref-unknown-frame',
          snippet: r.substring(0, 100),
          message: `figmaRef "${r}" does not match any fetched Figma frame name or id. Known frames: ${figmaFrames.slice(0, 10).map(f => `${f.name} (${f.id})`).join(' | ')}`
        });
      } else if (nameCounts[key] > 1) {
        findings.push({
          tcId,
          field: 'figmaRef',
          rule: 'figma-ref-ambiguous',
          snippet: r.substring(0, 100),
          message: `figmaRef "${r}" matches ${nameCounts[key]} frames with the same name. Use the frame id instead: ${figmaFrames.filter(f => String(f.name).trim().toLowerCase() === key).map(f => f.id).join(', ')}`
        });
      }
    });
  });
  return findings;
}

// Locate the fetched Figma frames for this run: <id>-figma.json, else data.json's figma.
function loadFigmaFrames(inputFile) {
  const candidates = [
    inputFile.replace(/-testcases\.json$/, '-figma.json'),
    inputFile.replace(/-testcases\.json$/, '-data.json')
  ];
  for (const p of candidates) {
    if (p === inputFile || !fs.existsSync(p)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      const figma = j.frames ? j : j.figma;
      if (figma && figma.found && Array.isArray(figma.frames)) return figma.frames;
    } catch (_) { /* ignore unreadable candidate */ }
  }
  return [];
}

// Gap 5: Pre-flight reuse estimator.
// Wraps the same domain-knowledge fuzzy match used by per-step rules and aggregates
// it per test case + overall. Surfaces the reusability % the QA reviewer should
// expect when Agent 3 runs on these test cases. The reviewer sees this BEFORE
// approving the Excel + adding Automation tags - no surprises downstream.
function preflightReuseEstimate(testCases) {
  const dkPatterns = loadDomainKnowledgeSteps();
  const perTC = [];
  let totalSteps = 0;
  let totalMatched = 0;

  for (const tc of testCases) {
    const tcId = tc.id || tc.title || '(unknown)';
    const stepLines = (tc.steps || '')
      .split(/\r?\n/)
      .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
      .filter(l => l.length >= SHORT_STEP_MIN_CHARS);
    if (stepLines.length === 0) {
      perTC.push({ tcId, stepCount: 0, matched: 0, pct: 0, status: 'EMPTY' });
      continue;
    }
    let matched = 0;
    for (const line of stepLines) {
      const score = bestDomainKnowledgeScore(line, dkPatterns);
      if (score >= 0.50) matched++;
    }
    totalSteps += stepLines.length;
    totalMatched += matched;
    const pct = Math.round((matched / stepLines.length) * 100);
    const status = pct >= 80 ? 'GOOD' : pct >= 50 ? 'WEAK' : 'POOR';
    perTC.push({ tcId, stepCount: stepLines.length, matched, pct, status });
  }

  const overallPct = totalSteps > 0 ? Math.round((totalMatched / totalSteps) * 100) : 0;
  return {
    dkPatternCount: dkPatterns.length,
    totalSteps,
    totalMatched,
    overallPct,
    perTC,
    gateThreshold: 80,
    passesGate: overallPct >= 80,
  };
}

// =============================================================================
// CLI
// =============================================================================

function buildSummary(errors, findings) {
  const byRule = {};
  for (const f of [...errors, ...findings]) {
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  }
  return byRule;
}

function printConsole(errors, findings, preflight) {
  console.log('');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('🔎 Agent 1 - Validation & Lint');
  console.log('═══════════════════════════════════════════════════════════');

  if (errors.length === 0 && findings.length === 0) {
    console.log('✅ Clean - no validation errors and no lint findings');
  }

  if (errors.length > 0) {
    console.log(`\n❌ ${errors.length} validation error(s) - STOP, do not build the Excel or push to test management:\n`);
    errors.forEach(e => {
      console.log(`   [${e.tcId || 'GLOBAL'}] ${e.rule}${e.field ? ` (${e.field})` : ''}: ${e.message}`);
    });
  }

  if (findings.length > 0) {
    console.log(`\n⚠️  ${findings.length} lint finding(s) - fix the flagged test cases and re-run:\n`);
    const summary = buildSummary([], findings);
    Object.entries(summary).forEach(([rule, count]) => {
      console.log(`   - ${rule}: ${count}`);
    });
    console.log('\n   Per-test-case findings written to the lint JSON file (see path below).');
  }

  // Gap 5: Pre-flight reuse estimate. Shown last so it's the takeaway message.
  if (preflight) {
    console.log('');
    console.log('🔮 Pre-flight Agent 3 reuse estimate');
    console.log('───────────────────────────────────────────────────────────');
    if (preflight.dkPatternCount === 0) {
      console.log('   ⚠️ steering/step-library.md not found - skipping estimate.');
      console.log('      Run: npm run step-library');
    } else {
      const verdict = preflight.passesGate
        ? `✅ PASS (≥${preflight.gateThreshold}%)`
        : `❌ BELOW GATE (<${preflight.gateThreshold}%)`;
      console.log(`   Overall estimated reusability: ${preflight.overallPct}%  ${verdict}`);
      console.log(`   Matched: ${preflight.totalMatched}/${preflight.totalSteps} step(s) against ${preflight.dkPatternCount} domain-knowledge patterns`);
      const weak = preflight.perTC.filter(p => p.status !== 'GOOD');
      if (weak.length > 0) {
        console.log(`\n   Test cases below 80% (will produce [NEW] markers in Agent 3):`);
        weak.slice(0, 10).forEach(p => {
          console.log(`     - ${p.tcId}: ${p.matched}/${p.stepCount} (${p.pct}%) - ${p.status}`);
        });
        if (weak.length > 10) console.log(`     … and ${weak.length - 10} more`);
        console.log('\n   Decompose these test cases into atomic steps that match patterns in');
        console.log('   steering/step-library.md before approving the Excel.');
      }
    }
  }

  console.log('');
}

function runCli() {
  const args = process.argv.slice(2);
  const inputFile = args.find(a => a.startsWith('--inputFile='))?.split('=')[1];
  const quiet = args.includes('--quiet');

  if (!inputFile) {
    console.error('Usage: node scripts/agents/agent1-validate-and-lint.js --inputFile=<path>');
    process.exit(1);
  }

  if (!fs.existsSync(inputFile)) {
    console.error(`❌ Input file not found: ${inputFile}`);
    process.exit(1);
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  } catch (e) {
    console.error(`❌ Failed to parse JSON: ${e.message}`);
    process.exit(1);
  }

  const { workItem, testCases } = input;
  if (!testCases) {
    console.error('❌ Input has no "testCases" array');
    process.exit(1);
  }

  // Top-level contract checks (e.g., automationRepoReferences[] presence) run BEFORE
  // per-test-case validation. They are validator-level errors - exit 1 if any.
  const inputErrors = validateInput(input);
  const tcErrors = validateTestCases(testCases);
  const errors = [...inputErrors, ...tcErrors];
  const findings = errors.length > 0 ? [] : [
    ...lintTestCases(
      testCases,
      workItem || {},
      input.automationRepoReferences || [],
      input.clarificationQuestions || []
    ),
    ...lintFigmaRefs(testCases, loadFigmaFrames(inputFile))
  ];
  // Gap 5: pre-flight runs even when no lint findings - surfaces the reusability
  // estimate as a fact the QA reviewer should see before approving.
  const preflight = errors.length > 0 ? null : preflightReuseEstimate(testCases);

  // Always write a lint JSON next to the input so Claude can read it for surgical fixes
  const lintPath = /-testcases\.json$/.test(inputFile) ? inputFile.replace(/-testcases\.json$/, '-lint.json') : inputFile.replace(/\.json$/, '-lint.json');
  const safeLintPath = lintPath === inputFile ? `${inputFile}.lint.json` : lintPath;

  const lintReport = {
    inputFile,
    validatedAt: new Date().toISOString(),
    errorCount: errors.length,
    warningCount: findings.length,
    summary: buildSummary(errors, findings),
    errors,
    warnings: findings,
    preflight: preflight || null
  };

  fs.writeFileSync(safeLintPath, JSON.stringify(lintReport, null, 2));

  if (!quiet) {
    printConsole(errors, findings, preflight);
    console.log(`📄 Lint report: ${safeLintPath}\n`);
  }

  if (errors.length > 0) process.exit(1);
  if (findings.length > 0) process.exit(2);
  process.exit(0);
}

if (require.main === module) {
  runCli();
}

module.exports = {
  validateInput,
  validateTestCases,
  lintTestCases,
  lintFigmaRefs,
  loadFigmaFrames,
  preflightReuseEstimate,
  loadDomainKnowledgeSteps,
  detectScenarioType,
  normalizeTitle,
  VALID_PRIORITIES
};
