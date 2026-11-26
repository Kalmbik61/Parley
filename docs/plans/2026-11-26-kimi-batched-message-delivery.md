# Confirm native Kimi message delivery

1. In the desktop chat outbox, reconcile complete local Kimi sends against a native Kimi user prompt. Preserve each send’s history boundary, provider identity and single use across feed replay and an in-flight terminal acknowledgement. This task is senior-owned because a race during delivery recovery can make a received message appear eligible for resending.
2. Show the pending native Kimi receipt next to the message until it reaches the conversation. Keep the browser annotation and its screenshot visible as an attachment when Kimi places them before the feedback in the same prompt.
3. Verify the observed attachment-plus-feedback batch, a delayed receipt, other providers and unchanged terminal write counts. Replay a native receipt and check the desktop renderer before publishing.
