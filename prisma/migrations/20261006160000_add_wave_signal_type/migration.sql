-- Add the `wave` signal type.
--
-- A wave is a low-commitment greeting sent before any connection exists, so it
-- cannot ride the WebRTC data channel (there isn't one yet). It travels
-- through the same transient mailbox as the rest of the signaling and is
-- discarded on read like every other signal.
--
-- ADD VALUE cannot run inside a transaction on older Postgres, which is why
-- this is its own migration rather than being folded into a table rebuild.
ALTER TYPE "SignalType" ADD VALUE 'wave';
