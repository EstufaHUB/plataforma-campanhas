-- Nível de acesso por usuário: lista de áreas liberadas (null = padrão do papel).
-- Administradores têm tudo; a equipe só o que estiver em "acessos".
alter table public.perfis add column if not exists acessos jsonb;

create or replace function public.tem_acesso(area text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select p.papel = 'admin'
                       or (p.papel = 'equipe' and coalesce(p.acessos, '["campanhas","acoes","status","calendarios","config"]'::jsonb) ? area)
                   from public.perfis p where p.id = auth.uid()), false);
$$;

-- só admin muda acessos (além de papel, cliente, área e cargo)
create or replace function public.perfis_protege() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and public.papel_atual() <> 'admin' and (
       new.papel is distinct from old.papel or new.cliente_id is distinct from old.cliente_id
    or new.email is distinct from old.email or new.area is distinct from old.area or new.cargo is distinct from old.cargo
    or new.acessos is distinct from old.acessos) then
    raise exception 'Só administradores alteram perfil de acesso, cliente, área e cargo.';
  end if;
  return new;
end $$;

-- invoices: ver, editar e excluir só com a área "invoices" liberada; criar continua para a equipe
-- (a campanha nova cria a invoice "Fee pendente")
drop policy if exists "invoices: equipe lê" on public.invoices;
drop policy if exists "invoices: equipe edita" on public.invoices;
drop policy if exists "invoices: equipe exclui" on public.invoices;
create policy "invoices: quem tem acesso lê"     on public.invoices for select using (public.tem_acesso('invoices'));
create policy "invoices: quem tem acesso edita"  on public.invoices for update using (public.tem_acesso('invoices')) with check (public.tem_acesso('invoices'));
create policy "invoices: quem tem acesso exclui" on public.invoices for delete using (public.tem_acesso('invoices'));
