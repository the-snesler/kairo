-- Single-user deployment guard. Remove this trigger in the migration that enables multi-user signups.
CREATE TRIGGER user_single_owner BEFORE INSERT ON user
WHEN EXISTS (SELECT 1 FROM user)
BEGIN
  SELECT RAISE(ABORT, 'Registration is closed');
END;
