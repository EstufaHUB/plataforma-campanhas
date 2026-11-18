-- Perfil de cada usuário: foto, área e cargo. Cada um edita o próprio nome e foto;
-- só administradores mudam perfil de acesso, cliente, área e cargo.
alter table public.perfis
  add column if not exists foto  text,
  add column if not exists area  text,
  add column if not exists cargo text;

drop policy if exists "perfis: edita o próprio" on public.perfis;
create policy "perfis: edita o próprio" on public.perfis
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create or replace function public.perfis_protege() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.papel_atual() <> 'admin' and (
       new.papel is distinct from old.papel or new.cliente_id is distinct from old.cliente_id
    or new.email is distinct from old.email or new.area is distinct from old.area or new.cargo is distinct from old.cargo) then
    raise exception 'Só administradores alteram perfil de acesso, cliente, área e cargo.';
  end if;
  return new;
end $$;

drop trigger if exists perfis_protege on public.perfis;
create trigger perfis_protege before update on public.perfis
  for each row execute function public.perfis_protege();
