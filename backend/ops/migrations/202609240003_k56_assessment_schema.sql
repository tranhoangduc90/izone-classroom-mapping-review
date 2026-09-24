-- Dữ liệu vào: DDL chỉ-schema của database K56 hiện hành; SHA-256 nguồn: 905758b7666d85c61d8f8ddf4d114a43e561629f1866d2690b63d34900ae2ce6.
-- Việc chính: tạo schema bài thi K56 bên trong mapping_db, không đổi assessment K67.
-- Kết quả: bảng, view, sequence, function và ràng buộc K56 đúng nguồn.
-- Khi lỗi: toàn giao dịch rollback; không sửa dữ liệu K67 hoặc hồ sơ học viên.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '120s';
SET LOCAL check_function_bodies = off;

CREATE SCHEMA assessment_k56;


--
-- Name: reset_demo_term_test_student(text, text, uuid); Type: FUNCTION; Schema: assessment_k56; Owner: -
--

CREATE FUNCTION assessment_k56.reset_demo_term_test_student(p_class_code text, p_test_slug text, p_student_ref uuid) RETURNS TABLE(deleted_attempts integer, deleted_sessions integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog', 'assessment_k56', 'mapping'
    AS $$
DECLARE
  normalized_class TEXT := upper(trim(p_class_code));
  normalized_slug TEXT := trim(p_test_slug);
  target_class_id BIGINT;
  target_student_id BIGINT;
  class_count INTEGER;
  has_curated_roster BOOLEAN := false;
  deleted_term_attempts INTEGER := 0;
  deleted_mini_results INTEGER := 0;
BEGIN
  IF NOT (
    (normalized_class = 'CODEXDEMO806'
      AND normalized_slug IN ('term-test-1', 'term-test-2', 'mini-test-lesson-5'))
    OR
    (normalized_class = 'CODEXDEMO56' AND normalized_slug IN ('term-test-1-k56', 'term-test-2-k56', 'mini-test-k56'))
  ) THEN
    RAISE EXCEPTION 'Chỉ được reset đúng lớp và bài thi demo đã cho phép.'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)::INTEGER, min(course.erp_course_class_id)
  INTO class_count, target_class_id
  FROM mapping.classroom_course_mapping AS course
  WHERE upper(trim(course.erp_class_name_snapshot)) = normalized_class;

  IF class_count <> 1 OR target_class_id IS NULL THEN
    RAISE EXCEPTION 'Không tìm thấy duy nhất một lớp demo.'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT EXISTS (
    SELECT 1
    FROM assessment_k56.term_test_roster AS roster
    WHERE roster.test_slug = normalized_slug
      AND roster.erp_course_class_id = target_class_id
  ) INTO has_curated_roster;

  IF has_curated_roster THEN
    SELECT roster.erp_student_contact_id
    INTO target_student_id
    FROM assessment_k56.term_test_roster AS roster
    WHERE roster.test_slug = normalized_slug
      AND roster.erp_course_class_id = target_class_id
      AND roster.student_ref = p_student_ref;
  ELSE
    SELECT review.erp_student_contact_id
    INTO target_student_id
    FROM mapping.student_mapping_review AS review
    WHERE review.erp_course_class_id = target_class_id
      AND review.public_id = p_student_ref
      AND review.status <> 'superseded';
  END IF;

  IF target_student_id IS NULL THEN
    RAISE EXCEPTION 'Học viên không thuộc roster demo.' USING ERRCODE = 'P0002';
  END IF;

  DELETE FROM assessment_k56.term_test_writing_grading_final AS final
  USING assessment_k56.term_test_attempt AS attempt
  WHERE final.attempt_id = attempt.id
    AND attempt.test_slug = normalized_slug
    AND attempt.erp_course_class_id = target_class_id
    AND attempt.erp_student_contact_id = target_student_id;

  UPDATE assessment_k56.term_test_attempt
  SET exam_session_id = NULL
  WHERE test_slug = normalized_slug
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

  UPDATE assessment_k56.term_test_exam_session
  SET attempt_id = NULL
  WHERE test_slug = normalized_slug
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;

  DELETE FROM assessment_k56.term_test_attempt
  WHERE test_slug = normalized_slug
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;
  GET DIAGNOSTICS deleted_term_attempts = ROW_COUNT;

  DELETE FROM assessment_k56.term_test_exam_session
  WHERE test_slug = normalized_slug
    AND erp_course_class_id = target_class_id
    AND erp_student_contact_id = target_student_id;
  GET DIAGNOSTICS deleted_sessions = ROW_COUNT;

  IF normalized_slug = 'mini-test-lesson-5' THEN
    DELETE FROM assessment_k56.mini_test_result
    WHERE test_slug = normalized_slug
      AND erp_course_class_id = target_class_id
      AND erp_student_contact_id = target_student_id;
    GET DIAGNOSTICS deleted_mini_results = ROW_COUNT;
  END IF;

  deleted_attempts := deleted_term_attempts + deleted_mini_results;
  RETURN NEXT;
END
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: mini_test_result; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.mini_test_result (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_submission_key text NOT NULL,
    test_slug text NOT NULL,
    erp_course_class_id bigint NOT NULL,
    class_name_snapshot text NOT NULL,
    erp_student_contact_id bigint NOT NULL,
    student_name_snapshot text NOT NULL,
    source_submitted_at text,
    listening_correct smallint NOT NULL,
    reading_correct smallint NOT NULL,
    result jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mini_test_result_listening_correct_check CHECK (((listening_correct >= 0) AND (listening_correct <= 20))),
    CONSTRAINT mini_test_result_reading_correct_check CHECK (((reading_correct >= 0) AND (reading_correct <= 13))),
    CONSTRAINT mini_test_result_test_slug_check CHECK ((test_slug ~ '^mini-test-[a-z0-9-]+$'::text))
);


--
-- Name: mini_test_student_lookup; Type: VIEW; Schema: assessment_k56; Owner: -
--

CREATE VIEW assessment_k56.mini_test_student_lookup AS
 SELECT target.erp_course_class_id,
    target.erp_class_name_snapshot AS class_name,
    membership.erp_student_contact_id,
    membership.erp_student_name_snapshot AS student_name
   FROM (mapping.classroom_course_mapping target
     JOIN mapping.erp_class_membership_snapshot membership ON ((membership.erp_course_class_id = target.erp_course_class_id)));


--
-- Name: term_test_attempt; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_attempt (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_submission_id uuid NOT NULL,
    test_slug text NOT NULL,
    definition_version integer NOT NULL,
    erp_course_class_id bigint NOT NULL,
    class_name_snapshot text NOT NULL,
    erp_student_contact_id bigint NOT NULL,
    student_name_snapshot text NOT NULL,
    exam_session_id uuid,
    listening_answers jsonb NOT NULL,
    listening_result jsonb NOT NULL,
    listening_submitted_at timestamp with time zone NOT NULL,
    reading_answers jsonb,
    reading_started_at timestamp with time zone,
    reading_deadline_at timestamp with time zone,
    reading_draft jsonb DEFAULT '{}'::jsonb NOT NULL,
    reading_draft_updated_at timestamp with time zone,
    reading_draft_revision bigint DEFAULT 0 NOT NULL,
    reading_result jsonb,
    combined_result jsonb,
    reading_submitted_at timestamp with time zone,
    completed_at timestamp with time zone,
    superseded_at timestamp with time zone,
    writing_task_1 text DEFAULT ''::text NOT NULL,
    writing_task_2 text DEFAULT ''::text NOT NULL,
    writing_started_at timestamp with time zone,
    writing_deadline_at timestamp with time zone,
    writing_updated_at timestamp with time zone,
    writing_submitted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    writing_draft_revision bigint DEFAULT 0 NOT NULL,
    CONSTRAINT term_test_attempt_section_deadline_check CHECK ((((reading_started_at IS NULL) AND (reading_deadline_at IS NULL)) OR ((reading_started_at IS NOT NULL) AND (reading_deadline_at > reading_started_at)))),
    CONSTRAINT term_test_attempt_writing_draft_revision_check CHECK ((writing_draft_revision >= 0)),
    CONSTRAINT term_test_attempt_writing_order_check CHECK ((((writing_started_at IS NULL) AND (writing_updated_at IS NULL) AND (writing_submitted_at IS NULL)) OR ((completed_at IS NOT NULL) AND (writing_started_at IS NOT NULL) AND (writing_updated_at IS NOT NULL) AND ((writing_submitted_at IS NULL) OR (writing_submitted_at >= writing_started_at)))))
);


--
-- Name: term_test_exam_session; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_exam_session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    test_slug text NOT NULL,
    definition_version integer NOT NULL,
    erp_course_class_id bigint NOT NULL,
    class_name_snapshot text NOT NULL,
    erp_student_contact_id bigint NOT NULL,
    student_name_snapshot text NOT NULL,
    prepared_at timestamp with time zone DEFAULT now() NOT NULL,
    listening_resume_offset_seconds integer DEFAULT 0 NOT NULL,
    listening_started_at timestamp with time zone,
    listening_deadline_at timestamp with time zone,
    listening_draft jsonb DEFAULT '{}'::jsonb NOT NULL,
    listening_draft_updated_at timestamp with time zone,
    listening_draft_revision bigint DEFAULT 0 NOT NULL,
    listening_submitted_at timestamp with time zone,
    superseded_at timestamp with time zone,
    attempt_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    listening_audio_checkpoint_seconds double precision DEFAULT 0 NOT NULL,
    listening_audio_checkpoint_at timestamp with time zone,
    listening_audio_state text DEFAULT 'ready'::text NOT NULL,
    listening_recovery_seconds integer DEFAULT 0 NOT NULL,
    CONSTRAINT term_test_exam_session_audio_checkpoint_check CHECK (((listening_audio_checkpoint_seconds >= (0)::double precision) AND (listening_audio_checkpoint_seconds <= (7200)::double precision))),
    CONSTRAINT term_test_exam_session_audio_recovery_check CHECK (((listening_recovery_seconds >= 0) AND (listening_recovery_seconds <= 900))),
    CONSTRAINT term_test_exam_session_audio_state_check CHECK ((listening_audio_state = ANY (ARRAY['ready'::text, 'playing'::text, 'pause'::text, 'waiting'::text, 'stalled'::text, 'pagehide'::text]))),
    CONSTRAINT term_test_exam_session_listening_order_check CHECK ((((listening_started_at IS NULL) AND (listening_deadline_at IS NULL) AND (listening_submitted_at IS NULL)) OR ((listening_started_at IS NOT NULL) AND (listening_deadline_at > listening_started_at) AND ((listening_submitted_at IS NULL) OR (listening_submitted_at >= listening_started_at))))),
    CONSTRAINT term_test_exam_session_listening_resume_offset_check CHECK (((listening_resume_offset_seconds >= 0) AND (listening_resume_offset_seconds <= 7200)))
);


--
-- Name: term_test_portal_sync_job; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_portal_sync_job (
    attempt_id uuid NOT NULL,
    request_version bigint DEFAULT 1 NOT NULL,
    claimed_version bigint,
    processed_version bigint DEFAULT 0 NOT NULL,
    writing_score numeric(3,1),
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    lease_until timestamp with time zone,
    worker_id text,
    last_error_code text,
    requested_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_portal_sync_job_attempts_check CHECK ((attempts >= 0)),
    CONSTRAINT term_test_portal_sync_job_check CHECK ((processed_version <= request_version)),
    CONSTRAINT term_test_portal_sync_job_claimed_version_check CHECK (((claimed_version IS NULL) OR (claimed_version > 0))),
    CONSTRAINT term_test_portal_sync_job_processed_version_check CHECK ((processed_version >= 0)),
    CONSTRAINT term_test_portal_sync_job_request_version_check CHECK ((request_version > 0)),
    CONSTRAINT term_test_portal_sync_job_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'retry'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: term_test_portal_sync_state; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_portal_sync_state (
    attempt_id uuid NOT NULL,
    payload_fingerprint text NOT NULL,
    test_slug text NOT NULL,
    grade_fields text[] DEFAULT '{}'::text[] NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    http_status integer,
    error_code text,
    duration_ms integer,
    attempted_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_portal_sync_duration_check CHECK (((duration_ms IS NULL) OR (duration_ms >= 0))),
    CONSTRAINT term_test_portal_sync_fingerprint_check CHECK ((payload_fingerprint ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT term_test_portal_sync_http_status_check CHECK (((http_status IS NULL) OR ((http_status >= 100) AND (http_status <= 599)))),
    CONSTRAINT term_test_portal_sync_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'synced'::text, 'failed_response'::text, 'unknown'::text])))
);


--
-- Name: term_test_roster; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_roster (
    test_slug text NOT NULL,
    erp_course_class_id bigint NOT NULL,
    erp_student_contact_id bigint NOT NULL,
    student_ref uuid NOT NULL,
    student_name_snapshot text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: term_test_temporary_student; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_temporary_student (
    temporary_student_id bigint NOT NULL,
    test_slug text NOT NULL,
    erp_course_class_id bigint NOT NULL,
    temporary_code_normalized text NOT NULL,
    student_ref uuid DEFAULT gen_random_uuid() NOT NULL,
    student_name_snapshot text NOT NULL,
    student_name_key text NOT NULL,
    active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_temporary_student_code_check CHECK ((temporary_code_normalized ~ '^[A-Z0-9][A-Z0-9_-]{1,15}$'::text)),
    CONSTRAINT term_test_temporary_student_name_check CHECK (((length(student_name_snapshot) >= 2) AND (length(student_name_snapshot) <= 80))),
    CONSTRAINT term_test_temporary_student_slug_check CHECK ((test_slug ~ '^mini-test-[a-z0-9-]+$'::text))
);


--
-- Name: term_test_temporary_student_temporary_student_id_seq; Type: SEQUENCE; Schema: assessment_k56; Owner: -
--

ALTER TABLE assessment_k56.term_test_temporary_student ALTER COLUMN temporary_student_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME assessment_k56.term_test_temporary_student_temporary_student_id_seq
    START WITH 9000000000000000000
    INCREMENT BY 1
    MINVALUE 9000000000000000000
    NO MAXVALUE
    CACHE 1
);


--
-- Name: term_test_writing_grading_component; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_writing_grading_component (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    criterion_code text NOT NULL,
    component_code text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    label text DEFAULT ''::text NOT NULL,
    summary text DEFAULT ''::text NOT NULL,
    feedback text DEFAULT ''::text NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_writing_grading_component_criterion_code_check CHECK ((criterion_code = ANY (ARRAY['TA'::text, 'TR'::text, 'CC'::text, 'LR'::text, 'GRA'::text]))),
    CONSTRAINT term_test_writing_grading_component_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'processing'::text, 'complete'::text, 'retry_wait'::text, 'failed'::text])))
);


--
-- Name: term_test_writing_grading_criterion; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_writing_grading_criterion (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    criterion_code text NOT NULL,
    status text DEFAULT 'waiting'::text NOT NULL,
    band_score numeric(2,1),
    feedback text DEFAULT ''::text NOT NULL,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_writing_grading_criterion_band_score_check CHECK (((band_score IS NULL) OR ((band_score >= (0)::numeric) AND (band_score <= (9)::numeric)))),
    CONSTRAINT term_test_writing_grading_criterion_criterion_code_check CHECK ((criterion_code = ANY (ARRAY['TA'::text, 'TR'::text, 'CC'::text, 'LR'::text, 'GRA'::text]))),
    CONSTRAINT term_test_writing_grading_criterion_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'processing'::text, 'complete'::text, 'retry_wait'::text, 'failed'::text])))
);


--
-- Name: term_test_writing_grading_final; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_writing_grading_final (
    attempt_id uuid NOT NULL,
    grading_version integer DEFAULT 1 NOT NULL,
    task_1_run_id uuid,
    task_2_run_id uuid,
    task_1_score numeric(2,1),
    task_2_score numeric(2,1),
    writing_score numeric(2,1),
    status text DEFAULT 'waiting'::text NOT NULL,
    ready_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_writing_grading_final_grading_version_check CHECK ((grading_version > 0)),
    CONSTRAINT term_test_writing_grading_final_status_check CHECK ((status = ANY (ARRAY['waiting'::text, 'ready'::text]))),
    CONSTRAINT term_test_writing_grading_final_task_1_score_check CHECK (((task_1_score IS NULL) OR ((task_1_score >= (0)::numeric) AND (task_1_score <= (9)::numeric)))),
    CONSTRAINT term_test_writing_grading_final_task_2_score_check CHECK (((task_2_score IS NULL) OR ((task_2_score >= (0)::numeric) AND (task_2_score <= (9)::numeric)))),
    CONSTRAINT term_test_writing_grading_final_writing_score_check CHECK (((writing_score IS NULL) OR ((writing_score >= (0)::numeric) AND (writing_score <= (9)::numeric))))
);


--
-- Name: term_test_writing_grading_job; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_writing_grading_job (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    run_id uuid NOT NULL,
    job_type text NOT NULL,
    idempotency_key text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    max_attempts integer DEFAULT 8 NOT NULL,
    next_attempt_at timestamp with time zone DEFAULT now() NOT NULL,
    worker_id text,
    leased_at timestamp with time zone,
    lease_until timestamp with time zone,
    last_error_code text,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_writing_grading_job_attempt_count_check CHECK ((attempt_count >= 0)),
    CONSTRAINT term_test_writing_grading_job_job_type_check CHECK ((job_type = ANY (ARRAY['dispatch'::text, 'collect'::text]))),
    CONSTRAINT term_test_writing_grading_job_max_attempts_check CHECK ((max_attempts > 0)),
    CONSTRAINT term_test_writing_grading_job_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'processing'::text, 'retry_wait'::text, 'complete'::text, 'failed'::text])))
);


--
-- Name: term_test_writing_grading_run; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.term_test_writing_grading_run (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    attempt_id uuid NOT NULL,
    task_number smallint NOT NULL,
    grading_version integer DEFAULT 1 NOT NULL,
    run_key text NOT NULL,
    prompt_text text NOT NULL,
    prompt_image_url text,
    essay_text text NOT NULL,
    word_count integer DEFAULT 0 NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    lark_record_id text,
    task_score numeric(2,1),
    result_json jsonb,
    last_error_code text,
    started_at timestamp with time zone,
    completed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT term_test_writing_grading_run_grading_version_check CHECK ((grading_version > 0)),
    CONSTRAINT term_test_writing_grading_run_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'retry_wait'::text, 'grading'::text, 'complete'::text, 'review_required'::text, 'failed'::text]))),
    CONSTRAINT term_test_writing_grading_run_task_number_check CHECK ((task_number = ANY (ARRAY[1, 2]))),
    CONSTRAINT term_test_writing_grading_run_task_score_check CHECK (((task_score IS NULL) OR ((task_score >= (0)::numeric) AND (task_score <= (9)::numeric)))),
    CONSTRAINT term_test_writing_grading_run_word_count_check CHECK ((word_count >= 0))
);


--
-- Name: test_definition; Type: TABLE; Schema: assessment_k56; Owner: -
--

CREATE TABLE assessment_k56.test_definition (
    slug text NOT NULL,
    title text NOT NULL,
    version integer NOT NULL,
    listening_band_adjustment numeric(3,1) DEFAULT 0 NOT NULL,
    listening_definition jsonb NOT NULL,
    reading_definition jsonb NOT NULL,
    is_active boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT test_definition_slug_check CHECK ((slug ~ '^(term-test-[1-9][0-9]*(-k[1-9][0-9]*)?|mini-test-[a-z0-9-]+)$'::text)),
    CONSTRAINT test_definition_version_check CHECK ((version > 0))
);


--
-- Name: mini_test_result mini_test_result_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.mini_test_result
    ADD CONSTRAINT mini_test_result_pkey PRIMARY KEY (id);


--
-- Name: mini_test_result mini_test_result_test_slug_source_submission_key_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.mini_test_result
    ADD CONSTRAINT mini_test_result_test_slug_source_submission_key_key UNIQUE (test_slug, source_submission_key);


--
-- Name: term_test_attempt term_test_attempt_exam_session_id_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_attempt
    ADD CONSTRAINT term_test_attempt_exam_session_id_key UNIQUE (exam_session_id);


--
-- Name: term_test_attempt term_test_attempt_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_attempt
    ADD CONSTRAINT term_test_attempt_pkey PRIMARY KEY (id);


--
-- Name: term_test_attempt term_test_attempt_test_slug_client_submission_id_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_attempt
    ADD CONSTRAINT term_test_attempt_test_slug_client_submission_id_key UNIQUE (test_slug, client_submission_id);


--
-- Name: term_test_exam_session term_test_exam_session_attempt_id_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_exam_session
    ADD CONSTRAINT term_test_exam_session_attempt_id_key UNIQUE (attempt_id);


--
-- Name: term_test_exam_session term_test_exam_session_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_exam_session
    ADD CONSTRAINT term_test_exam_session_pkey PRIMARY KEY (id);


--
-- Name: term_test_portal_sync_job term_test_portal_sync_job_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_portal_sync_job
    ADD CONSTRAINT term_test_portal_sync_job_pkey PRIMARY KEY (attempt_id);


--
-- Name: term_test_portal_sync_state term_test_portal_sync_state_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_portal_sync_state
    ADD CONSTRAINT term_test_portal_sync_state_pkey PRIMARY KEY (attempt_id, payload_fingerprint);


--
-- Name: term_test_roster term_test_roster_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_roster
    ADD CONSTRAINT term_test_roster_pkey PRIMARY KEY (test_slug, erp_course_class_id, erp_student_contact_id);


--
-- Name: term_test_roster term_test_roster_test_slug_student_ref_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_roster
    ADD CONSTRAINT term_test_roster_test_slug_student_ref_key UNIQUE (test_slug, student_ref);


--
-- Name: term_test_temporary_student term_test_temporary_student_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_temporary_student
    ADD CONSTRAINT term_test_temporary_student_pkey PRIMARY KEY (temporary_student_id);


--
-- Name: term_test_temporary_student term_test_temporary_student_test_slug_erp_course_class_id_t_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_temporary_student
    ADD CONSTRAINT term_test_temporary_student_test_slug_erp_course_class_id_t_key UNIQUE (test_slug, erp_course_class_id, temporary_code_normalized);


--
-- Name: term_test_temporary_student term_test_temporary_student_test_slug_student_ref_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_temporary_student
    ADD CONSTRAINT term_test_temporary_student_test_slug_student_ref_key UNIQUE (test_slug, student_ref);


--
-- Name: term_test_writing_grading_component term_test_writing_grading_component_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_component
    ADD CONSTRAINT term_test_writing_grading_component_pkey PRIMARY KEY (id);


--
-- Name: term_test_writing_grading_component term_test_writing_grading_component_run_id_component_code_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_component
    ADD CONSTRAINT term_test_writing_grading_component_run_id_component_code_key UNIQUE (run_id, component_code);


--
-- Name: term_test_writing_grading_criterion term_test_writing_grading_criterion_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_criterion
    ADD CONSTRAINT term_test_writing_grading_criterion_pkey PRIMARY KEY (id);


--
-- Name: term_test_writing_grading_criterion term_test_writing_grading_criterion_run_id_criterion_code_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_criterion
    ADD CONSTRAINT term_test_writing_grading_criterion_run_id_criterion_code_key UNIQUE (run_id, criterion_code);


--
-- Name: term_test_writing_grading_final term_test_writing_grading_final_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_final
    ADD CONSTRAINT term_test_writing_grading_final_pkey PRIMARY KEY (attempt_id);


--
-- Name: term_test_writing_grading_job term_test_writing_grading_job_idempotency_key_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_job
    ADD CONSTRAINT term_test_writing_grading_job_idempotency_key_key UNIQUE (idempotency_key);


--
-- Name: term_test_writing_grading_job term_test_writing_grading_job_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_job
    ADD CONSTRAINT term_test_writing_grading_job_pkey PRIMARY KEY (id);


--
-- Name: term_test_writing_grading_run term_test_writing_grading_run_attempt_id_task_number_gradin_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_run
    ADD CONSTRAINT term_test_writing_grading_run_attempt_id_task_number_gradin_key UNIQUE (attempt_id, task_number, grading_version);


--
-- Name: term_test_writing_grading_run term_test_writing_grading_run_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_run
    ADD CONSTRAINT term_test_writing_grading_run_pkey PRIMARY KEY (id);


--
-- Name: term_test_writing_grading_run term_test_writing_grading_run_run_key_key; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_run
    ADD CONSTRAINT term_test_writing_grading_run_run_key_key UNIQUE (run_key);


--
-- Name: test_definition test_definition_pkey; Type: CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.test_definition
    ADD CONSTRAINT test_definition_pkey PRIMARY KEY (slug);


--
-- Name: idx_mini_test_result_class_student; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_mini_test_result_class_student ON assessment_k56.mini_test_result USING btree (erp_course_class_id, erp_student_contact_id, test_slug, updated_at DESC);


--
-- Name: idx_term_test_attempt_class_student; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_attempt_class_student ON assessment_k56.term_test_attempt USING btree (erp_course_class_id, erp_student_contact_id, created_at DESC);


--
-- Name: idx_term_test_attempt_completed; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_attempt_completed ON assessment_k56.term_test_attempt USING btree (test_slug, completed_at DESC) WHERE (completed_at IS NOT NULL);


--
-- Name: idx_term_test_portal_sync_ready; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_portal_sync_ready ON assessment_k56.term_test_portal_sync_job USING btree (available_at, requested_at) WHERE (status = ANY (ARRAY['pending'::text, 'retry'::text]));


--
-- Name: idx_term_test_portal_sync_state_status; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_portal_sync_state_status ON assessment_k56.term_test_portal_sync_state USING btree (status, attempted_at DESC);


--
-- Name: idx_term_test_temporary_student_class; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_temporary_student_class ON assessment_k56.term_test_temporary_student USING btree (test_slug, erp_course_class_id, active, student_name_snapshot);


--
-- Name: idx_term_test_writing_grading_job_ready; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_writing_grading_job_ready ON assessment_k56.term_test_writing_grading_job USING btree (status, next_attempt_at);


--
-- Name: idx_term_test_writing_grading_run_attempt; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE INDEX idx_term_test_writing_grading_run_attempt ON assessment_k56.term_test_writing_grading_run USING btree (attempt_id, grading_version, task_number);


--
-- Name: uq_term_test_attempt_one_active_student; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE UNIQUE INDEX uq_term_test_attempt_one_active_student ON assessment_k56.term_test_attempt USING btree (test_slug, definition_version, erp_course_class_id, erp_student_contact_id) WHERE ((completed_at IS NULL) AND (superseded_at IS NULL));


--
-- Name: uq_term_test_exam_session_one_active_student; Type: INDEX; Schema: assessment_k56; Owner: -
--

CREATE UNIQUE INDEX uq_term_test_exam_session_one_active_student ON assessment_k56.term_test_exam_session USING btree (test_slug, definition_version, erp_course_class_id, erp_student_contact_id) WHERE ((listening_submitted_at IS NULL) AND (superseded_at IS NULL));


--
-- Name: term_test_attempt term_test_attempt_exam_session_fk; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_attempt
    ADD CONSTRAINT term_test_attempt_exam_session_fk FOREIGN KEY (exam_session_id) REFERENCES assessment_k56.term_test_exam_session(id);


--
-- Name: term_test_attempt term_test_attempt_test_slug_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_attempt
    ADD CONSTRAINT term_test_attempt_test_slug_fkey FOREIGN KEY (test_slug) REFERENCES assessment_k56.test_definition(slug);


--
-- Name: term_test_exam_session term_test_exam_session_attempt_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_exam_session
    ADD CONSTRAINT term_test_exam_session_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES assessment_k56.term_test_attempt(id);


--
-- Name: term_test_exam_session term_test_exam_session_test_slug_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_exam_session
    ADD CONSTRAINT term_test_exam_session_test_slug_fkey FOREIGN KEY (test_slug) REFERENCES assessment_k56.test_definition(slug);


--
-- Name: term_test_portal_sync_job term_test_portal_sync_job_attempt_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_portal_sync_job
    ADD CONSTRAINT term_test_portal_sync_job_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES assessment_k56.term_test_attempt(id) ON DELETE CASCADE;


--
-- Name: term_test_portal_sync_state term_test_portal_sync_state_attempt_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_portal_sync_state
    ADD CONSTRAINT term_test_portal_sync_state_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES assessment_k56.term_test_attempt(id) ON DELETE CASCADE;


--
-- Name: term_test_roster term_test_roster_test_slug_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_roster
    ADD CONSTRAINT term_test_roster_test_slug_fkey FOREIGN KEY (test_slug) REFERENCES assessment_k56.test_definition(slug) ON DELETE CASCADE;


--
-- Name: term_test_temporary_student term_test_temporary_student_test_slug_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_temporary_student
    ADD CONSTRAINT term_test_temporary_student_test_slug_fkey FOREIGN KEY (test_slug) REFERENCES assessment_k56.test_definition(slug) ON DELETE CASCADE;


--
-- Name: term_test_writing_grading_component term_test_writing_grading_component_run_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_component
    ADD CONSTRAINT term_test_writing_grading_component_run_id_fkey FOREIGN KEY (run_id) REFERENCES assessment_k56.term_test_writing_grading_run(id) ON DELETE CASCADE;


--
-- Name: term_test_writing_grading_criterion term_test_writing_grading_criterion_run_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_criterion
    ADD CONSTRAINT term_test_writing_grading_criterion_run_id_fkey FOREIGN KEY (run_id) REFERENCES assessment_k56.term_test_writing_grading_run(id) ON DELETE CASCADE;


--
-- Name: term_test_writing_grading_final term_test_writing_grading_final_attempt_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_final
    ADD CONSTRAINT term_test_writing_grading_final_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES assessment_k56.term_test_attempt(id) ON DELETE CASCADE;


--
-- Name: term_test_writing_grading_final term_test_writing_grading_final_task_1_run_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_final
    ADD CONSTRAINT term_test_writing_grading_final_task_1_run_id_fkey FOREIGN KEY (task_1_run_id) REFERENCES assessment_k56.term_test_writing_grading_run(id);


--
-- Name: term_test_writing_grading_final term_test_writing_grading_final_task_2_run_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_final
    ADD CONSTRAINT term_test_writing_grading_final_task_2_run_id_fkey FOREIGN KEY (task_2_run_id) REFERENCES assessment_k56.term_test_writing_grading_run(id);


--
-- Name: term_test_writing_grading_job term_test_writing_grading_job_run_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_job
    ADD CONSTRAINT term_test_writing_grading_job_run_id_fkey FOREIGN KEY (run_id) REFERENCES assessment_k56.term_test_writing_grading_run(id) ON DELETE CASCADE;


--
-- Name: term_test_writing_grading_run term_test_writing_grading_run_attempt_id_fkey; Type: FK CONSTRAINT; Schema: assessment_k56; Owner: -
--

ALTER TABLE ONLY assessment_k56.term_test_writing_grading_run
    ADD CONSTRAINT term_test_writing_grading_run_attempt_id_fkey FOREIGN KEY (attempt_id) REFERENCES assessment_k56.term_test_attempt(id) ON DELETE CASCADE;


--
-- PostgreSQL database dump complete
--

COMMIT;
