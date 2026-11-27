-- Only used when initializing the local development cluster.
CREATE ROLE cutroom_app LOGIN PASSWORD 'local-app';
CREATE ROLE cutroom_test_owner LOGIN PASSWORD 'local-test-owner';
CREATE ROLE cutroom_test_app LOGIN PASSWORD 'local-test-app';
CREATE DATABASE cutroom_test OWNER cutroom_test_owner;
REVOKE CONNECT ON DATABASE cutroom FROM PUBLIC;
GRANT CONNECT ON DATABASE cutroom TO cutroom_app;
REVOKE CONNECT ON DATABASE cutroom_test FROM PUBLIC;
GRANT CONNECT ON DATABASE cutroom_test TO cutroom_test_app;
ALTER DEFAULT PRIVILEGES FOR ROLE cutroom_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cutroom_app;
\connect cutroom_test
ALTER DEFAULT PRIVILEGES FOR ROLE cutroom_test_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cutroom_test_app;
