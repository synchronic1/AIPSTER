/* Built with Meta Muse. */
-- F1R: record which side suspended/disconnected a connection so resume
-- requires that same side's node proof (reactivation consent). NULL means
-- active / never suspended.
ALTER TABLE connections ADD COLUMN suspended_by TEXT;
