-- Fixes the "function_search_path_mutable" security advisory on
-- set_updated_at(): pin search_path so the function can't be tricked by a
-- malicious schema shadowing built-ins it (implicitly) relies on.
alter function public.set_updated_at() set search_path = '';
