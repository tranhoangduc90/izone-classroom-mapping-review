BEGIN;
CREATE TABLE speaking_independent.doc_progress (
  LIKE speaking_homework.doc_progress INCLUDING ALL,
  FOREIGN KEY(unit_id) REFERENCES speaking_independent.work_unit(id)
);
GRANT SELECT,INSERT,UPDATE ON speaking_independent.doc_progress TO speaking_independent_api;
COMMIT;
