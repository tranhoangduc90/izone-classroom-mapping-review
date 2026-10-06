-- Cấu trúc ghi lịch sử ghim từ snapshot; không chứa lịch sử hoặc dữ liệu học viên.
-- Giữ hàm/trigger; vai trò ứng dụng không được sửa hoặc đọc nhật ký này.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.14
-- Dumped by pg_dump version 16.14

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: collaboration; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA collaboration;


--
-- Name: attach_table(oid); Type: FUNCTION; Schema: collaboration; Owner: -
--

CREATE FUNCTION collaboration.attach_table(target oid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  qualified text;
BEGIN
  -- Bảng phân vùng có thể đã có trigger dòng kế thừa; vẫn cần trigger TRUNCATE riêng.
  SELECT format('%I.%I', n.nspname, c.relname) INTO qualified
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.oid = target AND c.relkind IN ('r', 'p')
    AND c.relpersistence <> 't'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'collaboration')
    AND n.nspname NOT LIKE 'pg_%'
    AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.classid = 'pg_class'::regclass
                    AND d.objid = c.oid AND d.deptype = 'e');
  IF qualified IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = target AND tgname = 'collaboration_row_history') THEN
    EXECUTE format('CREATE TRIGGER collaboration_row_history AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION collaboration.record_row()', qualified);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = target AND tgname = 'collaboration_truncate_history') THEN
    EXECUTE format('CREATE TRIGGER collaboration_truncate_history AFTER TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION collaboration.record_row()', qualified);
  END IF;
END;
$$;


--
-- Name: is_tracked(); Type: FUNCTION; Schema: collaboration; Owner: -
--

CREATE FUNCTION collaboration.is_tracked() RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
  SELECT EXISTS (SELECT 1 FROM collaboration.tracked_actor WHERE role_name = session_user);
$$;


--
-- Name: record_ddl(); Type: FUNCTION; Schema: collaboration; Owner: -
--

CREATE FUNCTION collaboration.record_ddl() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  cmd record;
  shape jsonb;
BEGIN
  FOR cmd IN SELECT * FROM pg_event_trigger_ddl_commands() LOOP
    IF cmd.in_extension OR cmd.schema_name = 'collaboration'
       OR coalesce(cmd.schema_name, '') LIKE 'pg_%'
       OR coalesce(cmd.object_identity, '') LIKE '%collaboration_row_history%'
       OR coalesce(cmd.object_identity, '') LIKE '%collaboration_truncate_history%' THEN CONTINUE; END IF;
    IF collaboration.is_tracked() THEN
      shape := NULL;
      IF cmd.classid = 'pg_class'::regclass THEN
        SELECT jsonb_agg(jsonb_build_object('column', a.attname,
                 'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull) ORDER BY a.attnum)
          INTO shape FROM pg_attribute a WHERE a.attrelid = cmd.objid AND a.attnum > 0 AND NOT a.attisdropped;
      END IF;
      INSERT INTO collaboration.audit_event(action, object_schema, object_name, object_identity, column_shape)
      VALUES (cmd.command_tag, cmd.schema_name, cmd.object_type, cmd.object_identity, shape);
    END IF;
    IF cmd.classid = 'pg_class'::regclass AND cmd.command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE') THEN
      PERFORM collaboration.attach_table(cmd.objid);
    END IF;
  END LOOP;
END;
$$;


--
-- Name: record_drop(); Type: FUNCTION; Schema: collaboration; Owner: -
--

CREATE FUNCTION collaboration.record_drop() RETURNS event_trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE obj record;
BEGIN
  IF NOT collaboration.is_tracked() THEN RETURN; END IF;
  FOR obj IN SELECT * FROM pg_event_trigger_dropped_objects() LOOP
    IF obj.is_temporary OR obj.schema_name = 'collaboration'
       OR coalesce(obj.schema_name, '') LIKE 'pg_%' THEN CONTINUE; END IF;
    INSERT INTO collaboration.audit_event(action, object_schema, object_name, object_identity)
    VALUES (TG_TAG, obj.schema_name, obj.object_type, obj.object_identity);
  END LOOP;
END;
$$;


--
-- Name: record_row(); Type: FUNCTION; Schema: collaboration; Owner: -
--

CREATE FUNCTION collaboration.record_row() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'pg_catalog'
    AS $$
DECLARE
  old_doc jsonb;
  new_doc jsonb;
  old_key jsonb;
  new_key jsonb;
  cols text[];
BEGIN
  -- Chỉ ghi vai trò quản trị được theo dõi; ứng dụng nền giữ lịch sử nghiệp vụ hiện có.
  IF NOT collaboration.is_tracked() THEN RETURN NULL; END IF;
  IF TG_OP = 'TRUNCATE' THEN
    INSERT INTO collaboration.audit_event(action, object_schema, object_name)
    VALUES (TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME);
    RETURN NULL;
  END IF;
  IF TG_OP <> 'INSERT' THEN old_doc := to_jsonb(OLD); END IF;
  IF TG_OP <> 'DELETE' THEN new_doc := to_jsonb(NEW); END IF;
  SELECT array_agg(k ORDER BY k) INTO cols
  FROM (SELECT jsonb_object_keys(coalesce(old_doc, '{}'::jsonb) || coalesce(new_doc, '{}'::jsonb)) k) names
  WHERE old_doc -> k IS DISTINCT FROM new_doc -> k;
  IF TG_OP = 'UPDATE' AND cols IS NULL THEN RETURN NULL; END IF;
  -- Giữ khóa chính để tìm đúng bản ghi; trường bí mật không được chép vào lịch sử.
  SELECT jsonb_object_agg(a.attname, old_doc -> a.attname),
         jsonb_object_agg(a.attname, new_doc -> a.attname)
    INTO old_key, new_key
  FROM pg_index i
  JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
  WHERE i.indrelid = TG_RELID AND i.indisprimary
    AND a.attname !~* '(password|secret|token|credential|private_key|api_key)';
  INSERT INTO collaboration.audit_event(action, object_schema, object_name, changed_columns, key_before, key_after)
  VALUES (TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME, cols,
          CASE WHEN old_doc IS NULL THEN NULL ELSE old_key END,
          CASE WHEN new_doc IS NULL THEN NULL ELSE new_key END);
  RETURN NULL;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: audit_event; Type: TABLE; Schema: collaboration; Owner: -
--

CREATE TABLE collaboration.audit_event (
    event_id bigint NOT NULL,
    happened_at timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
    transaction_id bigint DEFAULT txid_current() NOT NULL,
    session_actor text DEFAULT SESSION_USER NOT NULL,
    declared_role text DEFAULT current_setting('role'::text, true),
    application_name text DEFAULT current_setting('application_name'::text, true),
    action text NOT NULL,
    object_schema text,
    object_name text,
    object_identity text,
    changed_columns text[],
    key_before jsonb,
    key_after jsonb,
    column_shape jsonb
);


--
-- Name: TABLE audit_event; Type: COMMENT; Schema: collaboration; Owner: -
--

COMMENT ON TABLE collaboration.audit_event IS 'Nhật ký nội bộ: khóa chính có thể nhạy cảm; không xuất vào Git. Không lưu giá trị bài làm/điểm hoặc SQL thô.';


--
-- Name: audit_event_event_id_seq; Type: SEQUENCE; Schema: collaboration; Owner: -
--

ALTER TABLE collaboration.audit_event ALTER COLUMN event_id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME collaboration.audit_event_event_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: tracked_actor; Type: TABLE; Schema: collaboration; Owner: -
--

CREATE TABLE collaboration.tracked_actor (
    role_name text NOT NULL
);


--
-- Name: audit_event audit_event_pkey; Type: CONSTRAINT; Schema: collaboration; Owner: -
--

ALTER TABLE ONLY collaboration.audit_event
    ADD CONSTRAINT audit_event_pkey PRIMARY KEY (event_id);


--
-- Name: tracked_actor tracked_actor_pkey; Type: CONSTRAINT; Schema: collaboration; Owner: -
--

ALTER TABLE ONLY collaboration.tracked_actor
    ADD CONSTRAINT tracked_actor_pkey PRIMARY KEY (role_name);


--
-- PostgreSQL database dump complete
--




INSERT INTO collaboration.tracked_actor(role_name) VALUES ('k67_owner');
