# Clear sent messages when Codex records a batch

1. Reproduce two local sends of different delivery states becoming one Codex user message. Include multiline text, an attachment and a transcript order different from the order of the local sends.
2. Reconcile the batch in the desktop Chat outbox. Match complete messages from this Codex session within each send's history boundary. Consume each send once. Keep the transcript as the single displayed message and wake the queue using the confirmed send. The reconciliation is senior-owned because feed updates race the send response and reconnect replays old messages.
3. Verify receipt-before-send-response, repeated text, unrelated text, old snapshots and other providers. Check the rendered pending indicators and the absence of duplicate terminal writes. Publish the fix in a separate PR against master.
