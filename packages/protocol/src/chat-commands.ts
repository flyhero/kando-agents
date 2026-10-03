import { z } from 'zod'

export const MAX_CHAT_COMMANDS = 200
// What a command's prompt stands in for: whatever the user typed after its name.
export const CHAT_COMMAND_ARGUMENTS = '$ARGUMENTS'

// A prompt the user keeps under a slash command of their own. The composer expands it into the
// message being written, for any agent: Kando's commands never reach the agent as commands.
export const ChatCommandFields = z.object({
  name: z.string().trim().min(1).max(40).regex(/^[a-z0-9][a-z0-9_:-]*$/i),
  description: z.string().trim().max(200),
  prompt: z.string().trim().min(1).max(20_000),
  // Offered only in conversations on this folder; null, in every conversation.
  projectPath: z.string().min(1).nullable()
})
export const SavedChatCommand = ChatCommandFields.extend({ id: z.string().uuid(), createdAt: z.number() })
export type SavedChatCommand = z.infer<typeof SavedChatCommand>
