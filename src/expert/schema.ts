import { z } from 'zod'

export const modeSchema = z.enum(['free','professional'])
export type Mode = z.infer<typeof modeSchema>
export const decisions = ['认可','修改','批注','补充','依据不足','不适用'] as const
export type ReviewModule = { key: string; label: string; targets: { id: string; label: string; original: unknown }[] }
export const noteSchema = z.object({
 id: z.string().uuid(), module: z.string().min(1).max(100), target: z.string().min(1).max(200),
 decision: z.enum(decisions), text: z.string().max(6000).default(''), replacement: z.string().max(6000).default(''),
 evidence: z.string().max(6000).default(''), evidenceFiles: z.array(z.number().int().min(0).max(19)).max(20).default([]),
 knowledge: z.object({
  candidate: z.boolean().default(false), title: z.string().max(160).default(''),
  applicability: z.string().max(2000).default(''), exclusions: z.string().max(2000).default(''),
  keywords: z.array(z.string().min(2).max(80)).max(12).default([]),
  requiredTerms:z.array(z.string().min(2).max(80)).max(12).default([]),
  excludedTerms:z.array(z.string().min(2).max(80)).max(12).default([]),
 }).default({ candidate:false,title:'',applicability:'',exclusions:'',keywords:[],requiredTerms:[],excludedTerms:[] }),
})
export type ReviewNote = z.infer<typeof noteSchema>
export const reviewPayloadSchema = z.object({
 version:z.number().int().min(1), notes:z.array(noteSchema).max(250),
 confirmed:z.array(z.string().max(100)).max(80),
 drafts:z.record(noteSchema.omit({id:true,module:true})).default({}),
})
export const submitSchema = z.object({ version:z.number().int().min(1), attest:z.literal(true) })
export const loginSchema = z.object({ username:z.string().min(1).max(80),password:z.string().min(1).max(256) })
export type Session = { id:string;username:string;displayName:string;role:string;testAccount:boolean;csrf:string;tokenHash:string }
export class ExpertError extends Error {
 constructor(public status:number,public code:string,message:string){super(message)}
}
