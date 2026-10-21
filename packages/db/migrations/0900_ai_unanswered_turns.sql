-- Consecutive customer questions the AI could not ground in knowledge. The AI asks for clarification first and only
-- hands off after the agent's `maxUnansweredTurns`; a grounded answer or a return-to-AI resets it.
ALTER TABLE conversation_ai_state ADD COLUMN IF NOT EXISTS unanswered_turns integer NOT NULL DEFAULT 0;
