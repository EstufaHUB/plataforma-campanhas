-- Ctrl+Z do cliente: ele pode apagar a própria aprovação ou comentário enquanto a equipe ainda não aplicou.
-- Depois de aplicado (aplicado_em preenchido), não apaga mais.
drop policy if exists "aprovacoes: cliente desfaz as suas" on public.aprovacoes_cliente;
create policy "aprovacoes: cliente desfaz as suas" on public.aprovacoes_cliente for delete
  using (cliente_id = cliente_atual() and autor = auth.uid() and aplicado_em is null);

drop policy if exists "comentarios: cliente desfaz os seus" on public.comentarios_cliente;
create policy "comentarios: cliente desfaz os seus" on public.comentarios_cliente for delete
  using (cliente_id = cliente_atual() and autor = auth.uid() and aplicado_em is null);
