import { test } from 'node:test'
import assert from 'node:assert/strict'
import { embedTexts, cosine } from '../semantic.js'
import { checkConditions, diseaseKeys, canonicalModule, rankCandidates, selectDiverse, passageText, bm25, type MatchCandidate, type ScoredCandidate } from '../matching.js'
import { verifyApplicability } from '../applicability.js'
import { config } from '../../config.js'
import { matchProfile } from '../profile.js'
import type { MedicalFactBundle } from '../../report/medicalFactExtractor.js'

const item=(extra:Partial<MatchCandidate>={}):MatchCandidate=>({id:'medical-a',version:1,title:'乳腺癌术后费用预审',disease_key:'breast_cancer',module_key:'cost',guidance:'乳腺癌术后评估费用要依据病理分期和医院正式报价复核',evidence:'医院正式报价',applicability:'乳腺癌术后评估',exclusions:'诊断未确认',keywords:['费用','乳腺癌'],required_terms:['术后'],excluded_terms:['未确诊'],status:'expert_published',...extra})
test('canonical disease aliases and report field/module mapping are explicit',()=>{
 assert.ok(diseaseKeys('heart_surgery').includes('cardiology_cardiothoracic'))
 assert.ok(diseaseKeys('cardiology_cardiothoracic').includes('heart_surgery'))
 assert.equal(canonicalModule('costDetails'),'cost');assert.equal(canonicalModule('technology'),'advanced');assert.equal(canonicalModule('treatmentPathway'),'treatment');assert.equal(canonicalModule('unknown'),undefined)
})
test('required, excluded, negated and uncertain conditions fail closed in Chinese/English',()=>{
 for(const text of ['乳腺癌术前','未做术后评估','疑似术后病例','breast cancer without postoperative evaluation','乳腺癌术后未确诊']) assert.equal(checkConditions(item(),text).eligible,false,text)
 for(const text of ['乳腺癌术后评估','Postoperative breast cancer consultation','Pasca operasi kanker payudara']) assert.equal(checkConditions(item(),text).eligible,true,text)
})
test('HER2 polarity, absent/contradictory indicators and stage do not pass semantic similarity',()=>{
 const k=item({applicability:'HER2阳性，分期II期，乳腺癌术后评估'})
 for(const text of ['乳腺癌术后 HER2阴性 分期II期','乳腺癌术后 分期II期','乳腺癌术后 HER2阳性 分期IV期','乳腺癌术后 HER2阳性 HER2阴性 分期II期']) assert.equal(checkConditions(k,text).eligible,false,text)
 assert.equal(checkConditions(k,'乳腺癌术后 HER2阳性 分期II期').eligible,true)
 assert.equal(checkConditions(item({exclusions:'HER2阴性'}),'乳腺癌术后 HER2阴性').eligible,false)
})
test('lexical BM25 can retrieve older and bilingual terminology without relative zero-hit scoring',()=>{
 const scores=bm25(['乳腺癌术后费用和医院报价','乳腺癌术后天气与旅游'], 'Postoperative breast cancer cost quotation')
 assert.ok(scores[0]>scores[1]);assert.deepEqual(bm25(['医院报价'],'宇宙星系'),[0])
})
test('real offline E5 inference gives reproducible multilingual vectors and meaningful ranking',async()=>{
 const query='Postoperative breast cancer. Please review hospital quotation and pathology-based medical costs.'
 const [q]=await embedTexts([query],'query')
 const candidates=[item(),item({id:'b',title:'旅游购物行程',module_key:'itinerary',guidance:'旅游购物，纪念品，天气和观光计划',applicability:'无条件',keywords:[],required_terms:[],excluded_terms:[]})]
 const vectors=await embedTexts(candidates.map(passageText),'passage')
 assert.equal(q.length,384);assert.ok(cosine(q,vectors[0])>cosine(q,vectors[1]))
 const ranked=rankCandidates(candidates,vectors,query,q,['cost'])
 assert.equal(ranked.ranked[0]?.candidate.id,'medical-a')
 assert.ok(ranked.rejected.some(k=>k.id==='b'&&['module_mismatch','disease_evidence_missing'].includes(k.reason)))
 const repeat=await embedTexts([query],'query');assert.ok(cosine(q,repeat[0])>0.9999)
})
test('multiple modules are not limited to global top four; duplicates and context budget are enforced',()=>{
 const modules=['cost','treatment','risk','hospitals','next','advanced'] as const
 const ranked:ScoredCandidate[]=modules.map((m,i)=>({candidate:item({id:String(i),module_key:m,guidance:`不同模块知识${i}`}),module:m,vector:[1,i/10],match:{score:.9-i*.01,semantic:.9,lexical:.8,keyword:1,conditions:[],reasons:[],algorithm:'test'}}))
 assert.equal(selectDiverse(ranked).length,6)
 assert.equal(selectDiverse([...ranked,{...ranked[0],candidate:{...ranked[0].candidate,id:'duplicate'}}]).filter(k=>k.module==='cost').length,1)
 assert.equal(selectDiverse(ranked,1).length,0)
})
test('relevance gate refuses low-similarity zero-hit candidates',()=>{
 const k=item({required_terms:[],keywords:[],applicability:'任何人'})
 assert.equal(rankCandidates([k],[[1,0]],'风景观光',[0,1]).ranked.length,0)
})
test('matching profile redacts identity and preserves high-confidence clinical facts',()=>{
 const facts:MedicalFactBundle={documents:[],timeline:[],summary:'',evidenceHighlights:[],diseaseSignals:[],qualityFlags:[],sourceTextLength:0,hasActionableFacts:false}
 const profile=matchProfile({chiefComplaint:'PRIVATE_PERSON 术后复查 test@example.com +60123456789'},facts,['PRIVATE_PERSON','test@example.com','+60123456789'])
 assert.ok(profile.text.includes('术后'));assert.ok(!profile.text.includes('PRIVATE_PERSON'));assert.ok(!profile.text.includes('test@example.com'));assert.ok(!profile.text.includes('+60123456789'))
 const long=matchProfile({chiefComplaint:'乳腺癌术后'.repeat(5000)+'HER2阴性，严重禁忌'},facts,[])
 assert.equal(long.blockedReason,'clinical_profile_requires_compaction');assert.equal(long.text,'')
})
test('medical applicability verifier rejects fabricated evidence, conflicts, missing verdicts and outage',async()=>{
 const original=globalThis.fetch,oldKey=config.medicalLlmApiKey;config.medicalLlmApiKey='isolated-qa-only';config.medicalLlmStream=false
 const k:ScoredCandidate={candidate:item(),module:'cost',vector:[1],match:{score:.8,semantic:.9,lexical:.8,keyword:1,conditions:[],reasons:[],algorithm:'test'}}
 const source='乳腺癌术后，需核对医院报价。'
 const verdict={id:'medical-a',decision:'applicable',relevance:.95,supportingQuotes:['乳腺癌术后'],reason:'conditions_supported',conflictsWith:[] as string[]}
 const respond=(results:unknown[])=>{globalThis.fetch=async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({results})}}]}),{headers:{'content-type':'application/json'}})}
 try {
  respond([verdict]);assert.equal((await verifyApplicability(source,[k])).accepted.length,1)
  respond([{...verdict,supportingQuotes:['ER 80% 不在原文']}]);assert.equal((await verifyApplicability(source,[k])).accepted.length,0)
  respond([{...verdict,conflictsWith:['other']}]);assert.equal((await verifyApplicability(source,[k])).accepted.length,0)
  respond([]);assert.equal((await verifyApplicability(source,[k])).accepted.length,0)
  respond([{...verdict,decision:'insufficient',supportingQuotes:[]}]);assert.equal((await verifyApplicability(source,[k])).accepted.length,0)
  globalThis.fetch=async()=>{throw Error('isolated test outage')};assert.equal((await verifyApplicability(source,[k])).accepted.length,0)
 }finally{globalThis.fetch=original;config.medicalLlmApiKey=oldKey}
})
