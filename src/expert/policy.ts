// Default remains fail-closed for new installations. The current test deployment
// explicitly opts into expert publication; future confirmation can be enabled
// without changing existing review/knowledge records.
export const requiresKnowledgeConfirmation = () => process.env.EXPERT_KNOWLEDGE_REQUIRE_CONFIRMATION !== 'false'
export const knowledgePolicy = () => ({
 requireConfirmation: requiresKnowledgeConfirmation(),
 directFeedbackEnabled: !requiresKnowledgeConfirmation(),
 confirmationEnabled: false,
})
