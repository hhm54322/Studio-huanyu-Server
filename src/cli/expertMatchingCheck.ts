import assert from 'node:assert/strict'
import { config } from '../config.js'
import { disposeEmbeddingModel, embedTexts, semanticModel } from '../expert/semantic.js'
import { matchingVersion, passageText, rankCandidates, type MatchCandidate } from '../expert/matching.js'
import { verifyApplicability } from '../expert/applicability.js'

// Synthetic retrieval evaluation only: no patient records, database writes,
// reviewer submissions or full report generation. Uses the existing medical API.
assert.ok(config.medicalLlmApiKey || config.openaiApiKey, 'A configured medical provider is required for the live verification check')
const base: MatchCandidate = { id:'synthetic-cost',version:1,title:'乳腺癌术后费用报价核实',disease_key:'breast_cancer',module_key:'cost',
 guidance:'已确诊乳腺癌术后复查的费用应核实医院当前正式报价，不能使用历史病例预算承诺当前费用。',evidence:'测试用费用核实规则，非真实临床建议',
 applicability:'已确诊乳腺癌术后复查，正在咨询医院报价。',exclusions:'未确诊乳腺病变；并非咨询医疗报价的患者。',
 keywords:['乳腺癌','费用','报价'],required_terms:['术后'],excluded_terms:['未确诊'],status:'expert_published' }
const targeted: MatchCandidate = {...base,id:'synthetic-her2',module_key:'treatment',title:'HER2阳性术后方案复核',
 guidance:'HER2阳性术后患者的相关治疗方案需要专科医生复核，不为指标阴性或未知者套用。',
 applicability:'已确诊乳腺癌术后，HER2阳性，分期II期。',exclusions:'HER2阴性或状态未知；分期IV期。',keywords:['HER2']}
const unrelated: MatchCandidate = {...base,id:'synthetic-travel',module_key:'itinerary',title:'旅游购物',guidance:'景点购物天气旅游安排',applicability:'咨询旅游购物景点的人',exclusions:'仅咨询医疗费用者',keywords:['旅游'],required_terms:[],excluded_terms:[]}
const candidates=[base,targeted,unrelated],vectors=await embedTexts(candidates.map(passageText),'passage')
const scenarios=[
 {label:'chinese-cost-match',text:'【合成测试病例】已确诊乳腺癌，手术后复查；现在咨询医院医疗费用和正式报价。HER2阴性，分期II期。',expected:['synthetic-cost']},
 {label:'english-cost-match',text:'Synthetic case, not a real patient. Confirmed breast cancer, postoperative follow-up. Seeking hospital quotation and medical cost verification. HER2 negative, stage II.',expected:['synthetic-cost']},
 {label:'unconfirmed-rejected',text:'【合成测试病例】乳腺病变未确诊，没有手术；只咨询天气与旅游购物。',expected:[]},
 {label:'contraindicated-her2-rejected',text:'【合成测试病例】乳腺癌术后，HER2阴性，分期IV期，不咨询费用，仅核对HER2阳性方案是否适用。',expected:[]},
 {label:'missing-indicators-rejected',text:'【合成测试病例】乳腺癌术后，分期及HER2状态未知，不咨询费用，咨询靶向治疗。',expected:[]},
]
const results=[]
for(const s of scenarios){
 const [query]=await embedTexts([s.text],'query'),ranked=rankCandidates(candidates,vectors,s.text,query)
 const verified=await verifyApplicability(s.text,ranked.ranked),ids=verified.accepted.map(k=>k.candidate.id).sort()
 assert.deepEqual(ids,s.expected.sort(),`Retrieval verification failed: ${s.label}`)
 results.push({scenario:s.label,passed:true,accepted:ids,hardOrSemanticRejects:ranked.rejected.length,applicabilityRejects:verified.rejected.length})
}
console.log(JSON.stringify({algorithm:matchingVersion,model:semanticModel,syntheticOnly:true,realMedicalProvider:true,results},null,2))
await disposeEmbeddingModel()
