import { cosine } from './semantic.js'

export const matchingVersion = 'hybrid-e5-bm25-medical-rerank-v1'
export type KnowledgeModule = 'records' | 'pathology' | 'assessment' | 'treatment' | 'cost' | 'advanced' | 'comparison' | 'itinerary' | 'similarCases' | 'topDoctors' | 'service' | 'risk' | 'hospitals' | 'next'
export const moduleLabels: Record<KnowledgeModule, string> = {
  records: '病历资料解读', pathology: '病理诊断与指标', assessment: '病情综合评估',
  treatment: '治疗路径', cost: '费用预算和报价复核', advanced: '前沿技术药物',
  comparison: '国家地区就医对比', itinerary: '行程与停留时间', similarCases: '相似病例参考',
  topDoctors: '专家选择', service: '医疗服务和支付保险', risk: '风险预后', hospitals: '医院选择', next: '下一步就诊流程',
}
const moduleAliases: Record<string, KnowledgeModule> = {
  technology: 'advanced', outcome: 'risk', feasibility: 'assessment', payment: 'service',
  costDetails: 'cost', advancedCare: 'advanced', prognosis: 'risk', advantages: 'assessment',
  concerns: 'risk', timeline: 'itinerary', plan: 'treatment', 'fallback-9': 'comparison',
  'fallback-10': 'assessment', 'fallback-11': 'hospitals', 'fallback-12': 'treatment',
  countries: 'comparison', countryComparison: 'comparison', clinicalAssessment: 'assessment',
  diagnosticConclusion: 'pathology', executiveSummary: 'assessment', treatmentPathway: 'treatment',
  prognosisComparison: 'risk', technologyAdvantages: 'advanced', costBreakdown: 'cost',
  hospitalRecommendations: 'hospitals', servicePlan: 'service', paymentAndInsurance: 'service',
  risksAndDisclaimers: 'risk', nextSteps: 'next', patientSnapshot: 'records',
}
export const canonicalModule = (key: string): KnowledgeModule | undefined => moduleAliases[key] || (key in moduleLabels ? key as KnowledgeModule : undefined)
const diseaseAliases: Record<string, string> = { heart_surgery: 'cardiology_cardiothoracic', orthopedic: 'spine_surgery', checkup: 'premium_checkup' }
export const canonicalDisease = (key: string) => diseaseAliases[key] || key
export const diseaseKeys = (key: string) => [canonicalDisease(key), ...Object.keys(diseaseAliases).filter(k => diseaseAliases[k] === canonicalDisease(key))]
export const diseaseTerms: Record<string, string[]> = {
  breast_cancer: ['乳腺癌', 'breast cancer', 'breast carcinoma'], lung_cancer: ['肺癌', 'lung cancer'],
  liver_cancer: ['肝癌', 'liver cancer', 'hepatocellular carcinoma'], nasopharyngeal_cancer: ['鼻咽癌', 'nasopharyngeal cancer'],
  dental: ['牙科', '口腔', 'dental', 'dentistry'], neurosurgery: ['神经外科', '脑肿瘤', 'neurosurgery'],
  spine_surgery: ['脊柱', '腰椎', 'spine', 'orthopedic'], cardiology_cardiothoracic: ['心脏', '心血管', 'cardiology', 'cardiothoracic'],
  cardiovascular_tumor: ['心脏', '心血管肿瘤', 'cardiovascular tumor'], endocrinology_metabolism: ['内分泌', '糖尿病', 'endocrinology'], premium_checkup: ['体检', 'checkup'], other: ['综合', '医学评估', 'medical assessment'],
}
export type MatchInput = { text: string; modules?: string[]; blockedReason?: string }
export type MatchCandidate = {
  id: string; version: number; title: string; disease_key: string; module_key: string;
  guidance: string; evidence: string; applicability: string; exclusions: string;
  keywords: string[]; required_terms: string[]; excluded_terms: string[]; status: string;
}
export type MatchDetail = { score: number; semantic: number; lexical: number; keyword: number; conditions: string[]; reasons: string[]; algorithm: string; applicability?: { relevance: number; evidenceQuotes: string[] } }
export type ScoredCandidate = { candidate: MatchCandidate; module: KnowledgeModule; vector: number[]; match: MatchDetail }
export const normalize = (v: string) => v.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')

// Same medical concept across Chinese/English/Indonesian. Numeric markers and
// negation are deliberately NOT discarded by tokenization or semantic retrieval.
const concepts: string[][] = [
  ['术后', 'postoperative', 'post operative', 'after surgery', 'pasca operasi'],
  ['术前', 'preoperative', 'before surgery', 'sebelum operasi'],
  ['未确诊', 'not diagnosed', 'unconfirmed diagnosis', 'belum terdiagnosis'],
  ['乳腺癌', 'breast cancer', 'kanker payudara'], ['肺癌', 'lung cancer', 'kanker paru'],
  ['肝癌', 'liver cancer', 'hepatocellular carcinoma'], ['鼻咽癌', 'nasopharyngeal cancer'],
  ['牙科', 'dental', 'dentistry', 'gigi'], ['费用', 'cost', 'price', 'budget', 'biaya'],
  ['病理', 'pathology', 'histology', 'patologi'], ['放疗', 'radiotherapy', 'radiation therapy'],
  ['化疗', 'chemotherapy', 'kemoterapi'], ['转移', 'metastasis', 'metastatic', 'metastases'],
  ['分期', 'stage', 'staging', 'stadium'], ['报价', 'quotation', 'quote'],
]
function variants(term: string) {
  const n = normalize(term)
  return concepts.find(group => group.some(t => normalize(t) === n)) || [term]
}
export function termPresent(text: string, term: string) {
  return variants(term).some(t => {
    const value = normalize(t), source = normalize(text)
    if (/^[a-z0-9 _-]+$/.test(value)) return new RegExp(`(?<![a-z0-9])${escapeRegex(value)}(?![a-z0-9])`, 'i').test(source)
    return source.replace(/\s+/g, '').includes(value.replace(/\s+/g, ''))
  })
}
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sentences = (text: string) => normalize(text).split(/[。；;!?\n]|(?<=\.)\s+/).filter(Boolean)
function affirmedTerm(text: string, term: string) {
  return sentences(text).some(s => variants(term).some(v => {
    const start = normalize(s).indexOf(normalize(v)); if (start < 0) return false
    const prefix = s.slice(Math.max(0, start - 30), start)
    // A missing/denied/suspected prerequisite cannot satisfy an affirmative one.
    return !/(?:未|无|否认|没有|尚未|疑似|待确认|待核实|待排除|not|no|without|denies|suspected|possible|belum|tidak)[\s\p{Script=Han}a-z-]{0,16}$/iu.test(prefix)
  }))
}

function biomarkerStates(text: string) {
  const states = new Map<string, Set<string>>()
  for (const m of normalize(text).matchAll(/\b(her2|er|pr|egfr|alk|ros1|braf|idh1?|mgmt)\s*[:：=]?\s*(阳性|阴性|positive|negative|positif|negatif|\+|-(?!\d))/g)) {
    const state = /阳性|positive|positif|\+/.test(m[2]) ? 'positive' : 'negative'
    const values = states.get(m[1]) || new Set<string>(); values.add(state); states.set(m[1], values)
  }
  return states
}
function stageStates(text: string) {
  const stages = new Set<string>()
  for (const m of normalize(text).matchAll(/(?:stage|stadium|分期)\s*[:：]?\s*(iv|iii|ii|i|[1-4])\b|(?:^|[\s，,：:])(iv|iii|ii|i|[1-4])\s*[a-c]?期/g)) stages.add(m[1] || m[2])
  const roman: Record<string, string> = { i: '1', ii: '2', iii: '3', iv: '4' }
  return new Set([...stages].map(s => roman[s] || s))
}

export function checkConditions(candidate: MatchCandidate, text: string): { eligible: boolean; reason?: string; matched: string[] } {
  const matched: string[] = []
  for (const term of candidate.required_terms) {
    if (!affirmedTerm(text, term)) return { eligible: false, reason: 'required_condition_missing_or_uncertain', matched }
    matched.push(term)
  }
  if (candidate.excluded_terms.some(t => termPresent(text, t))) return { eligible: false, reason: 'excluded_condition', matched }
  const requirements = biomarkerStates(candidate.applicability), facts = biomarkerStates(text)
  for (const [marker, expected] of requirements) {
    const actual = facts.get(marker)
    if (!actual || actual.size !== 1 || expected.size !== 1 || !actual.has([...expected][0])) return { eligible: false, reason: 'biomarker_missing_or_conflicting', matched }
    matched.push(`${marker}:${[...expected][0]}`)
  }
  const stages = stageStates(candidate.applicability), current = stageStates(text)
  if (stages.size && (!current.size || [...current].some(s => !stages.has(s)))) return { eligible: false, reason: 'stage_missing_or_conflicting', matched }
  if (stages.size) matched.push(`stage:${[...current].join(',')}`)
  for (const phase of ['术后', '术前']) {
    if (termPresent(candidate.applicability, phase) && !affirmedTerm(text, phase)) return { eligible: false, reason: 'treatment_phase_missing_or_uncertain', matched }
  }
  // Structured exclusion facts are hard vetoes, not merely a lower score.
  for (const [marker, banned] of biomarkerStates(candidate.exclusions)) {
    if ([...(facts.get(marker) || [])].some(v => banned.has(v))) return { eligible: false, reason: 'excluded_biomarker', matched }
  }
  if ([...stageStates(candidate.exclusions)].some(s => current.has(s))) return { eligible: false, reason: 'excluded_stage', matched }
  return { eligible: true, matched }
}

export function tokens(text: string) {
  const normalized = normalize(text), out: string[] = Array.from(normalized.match(/[a-z][a-z0-9_-]+|\d+(?:\.\d+)?%?/g) || [])
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2))
  }
  concepts.forEach((group, i) => { if (group.some(t => termPresent(normalized, t))) out.push(`concept_${i}`) })
  return out
}
export const passageText = (k: MatchCandidate) => [k.title, k.applicability, k.guidance, k.keywords.join(' '), k.evidence].join('\n').slice(0, 4000)
export function bm25(corpus: string[], query: string): number[] {
  const docs = corpus.map(tokens), terms = [...new Set(tokens(query))], avg = docs.reduce((a, d) => a + d.length, 0) / (docs.length || 1)
  const frequencies = docs.map(doc => { const map = new Map<string, number>(); doc.forEach(t => map.set(t, (map.get(t) || 0) + 1)); return map })
  const documentCounts = new Map(terms.map(t => [t, frequencies.filter(d => d.has(t)).length]))
  return docs.map((doc, i) => terms.reduce((score, term) => {
    const freq = frequencies[i].get(term) || 0; if (!freq) return score
    const df = documentCounts.get(term) || 0
    const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5))
    return score + idf * freq * 2.2 / (freq + 1.2 * (0.25 + 0.75 * doc.length / (avg || 1)))
  }, 0))
}

// Do not deduplicate before conflict checking: opposing clinical advice often
// has almost identical embeddings. The verifier sees multiple candidates.
export function shortlistForVerification(ranked: ScoredCandidate[]) {
  const counts = new Map<KnowledgeModule, number>()
  return ranked.filter(k => { const count = counts.get(k.module) || 0; if (count >= 5) return false; counts.set(k.module, count + 1); return true })
}

export function rankCandidates(candidates: MatchCandidate[], vectors: number[][], query: string, queryVector: number[], modules?: string[]): { ranked: ScoredCandidate[]; rejected: { id: string; reason: string }[] } {
  const scores = bm25(candidates.map(passageText), query), maxLexical = Math.max(1, ...scores)
  const ranked: ScoredCandidate[] = [], rejected: { id: string; reason: string }[] = []
  const allowed = modules?.map(canonicalModule).filter(Boolean)
  candidates.forEach((k, index) => {
    const module = canonicalModule(k.module_key), conditions = checkConditions(k, query)
    const reject = (reason: string) => rejected.push({ id: k.id, reason })
    if (!module) { reject('unsupported_module'); return }
    if (!diseaseTerms[canonicalDisease(k.disease_key)]?.some(t => termPresent(passageText(k), t))) { reject('disease_evidence_missing'); return }
    if (allowed && !allowed.includes(module)) { reject('module_mismatch'); return }
    if (!conditions.eligible) { reject(conditions.reason!); return }
    const semantic = cosine(queryVector, vectors[index]), lexical = scores[index] / maxLexical
    const hits = k.keywords.filter(t => termPresent(query, t)), keyword = hits.length / Math.max(1, k.keywords.length)
    // E5 cosine is NOT a probability. Minimum semantic relevance is mandatory;
    // lexical confirmation relaxes the threshold slightly, never clinical gates.
    if (semantic < (hits.length || conditions.matched.length ? 0.74 : 0.82)) { reject('low_semantic_relevance'); return }
    const semanticQuality = Math.max(0, Math.min(1, (semantic - 0.65) / 0.3))
    const score = 0.65 * semanticQuality + 0.25 * lexical + 0.1 * keyword
    if (score < 0.5) { reject('below_match_threshold'); return }
    ranked.push({ candidate: k, module, vector: vectors[index], match: {
      algorithm: matchingVersion, score: Number(score.toFixed(4)), semantic: Number(semantic.toFixed(4)),
      lexical: Number(lexical.toFixed(4)), keyword: Number(keyword.toFixed(4)), conditions: conditions.matched,
      reasons: ['same_disease', `module:${module}`, ...(hits.length ? [`keyword_hits:${hits.length}`] : []), 'semantic_relevance_passed', 'clinical_conditions_passed'],
    } })
  })
  return { ranked: ranked.sort((a, b) => b.match.score - a.match.score || a.candidate.id.localeCompare(b.candidate.id)), rejected }
}

// MMR-style near-duplicate suppression and per-module budgets prevent one topic
// monopolizing an entire report. A single global top-four limit is not used.
export function selectDiverse(ranked: ScoredCandidate[], characterBudget = 36000) {
  const selected: ScoredCandidate[] = [], sizes = new Map<string, number>()
  let total = 0
  const modules = [...new Set(ranked.map(k => k.module))]
  for (let round = 0; round < 3; round++) for (const module of modules) {
    const candidates = ranked.filter(k => k.module === module && !selected.includes(k))
    const next = candidates.find(k => contextSize(k.candidate) + total <= characterBudget && contextSize(k.candidate) + (sizes.get(module) || 0) <= 16000 && !selected.some(s => s.module === k.module && (s.candidate.guidance === k.candidate.guidance || cosine(s.vector, k.vector) > 0.96)))
    if (!next) continue
    const size = contextSize(next.candidate)
    selected.push(next); total += size; sizes.set(module, (sizes.get(module) || 0) + size)
  }
  return selected
}
export const contextSize = (k: MatchCandidate) => k.title.length + k.guidance.length + k.evidence.length + k.applicability.length + k.exclusions.length + 900
