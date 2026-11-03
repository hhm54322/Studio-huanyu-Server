import { redactValue } from './cases.js'
import type { MedicalFactBundle } from '../report/medicalFactExtractor.js'
import type { MatchInput } from './matching.js'

// Only medical features participate in retrieval, never identity or storage paths.
export function matchProfile(fields: Record<string, unknown>, facts: MedicalFactBundle, identities: (string | undefined)[]): MatchInput {
 const terms = identities.filter((v): v is string => Boolean(v && v.trim().length >= 2))
 const sanitized = redactValue({ ...fields,
  medicalEvidence: facts.documents.filter(d => d.documentCategory === 'patient_record').map(d => ({
   reportType: d.reportType, diagnoses: d.diagnoses,
   indicators: d.indicators.filter(f => f.confidence >= 0.7).map(f => ({ name: f.name, value: f.value, evidence: f.evidence })),
   findings: d.findings.filter(f => f.confidence >= 0.7).map(f => ({ category: f.category, text: f.text, evidence: f.evidence })),
   metastasis: d.metastasisSignals.filter(f => f.confidence >= 0.7).map(f => ({ site: f.site, status: f.status, evidence: f.evidence })),
  })),
 }, terms)
 const pieces: string[] = []
 const collect = (value: unknown, key = '') => {
  if (typeof value === 'string' && value.trim()) pieces.push(`${key}: ${value}`)
  else if (Array.isArray(value)) value.forEach(v => collect(v, key))
  else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => collect(v, k))
 }
 collect(sanitized)
 const text = pieces.join('\n')
 // Never hide a late contraindication through silent profile truncation.
 return text.length > 20000 ? { text: '', blockedReason: 'clinical_profile_requires_compaction' } : { text }
}
