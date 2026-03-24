// frontend/src/pages/admin/AdminConceptos.jsx
import { useEffect, useState } from "react";
import { PlusIcon, PencilIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { adminApi } from "../../services/api";

const EMPTY_FORM = { nombre: "", asignatura: "", descripcion: "" };

export default function AdminConceptos() {
  const [conceptos, setConceptos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null); // null = creating, object = editing
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchConceptos() {
    setLoading(true);
    setError(null);
    try {
      const res = await adminApi.getConceptos();
      setConceptos(res.data.conceptos ?? []);
    } catch (err) {
      setError(err?.response?.data?.error ?? "Error al cargar los conceptos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchConceptos(); }, []);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(concepto) {
    setEditing(concepto);
    setForm({
      nombre: concepto.nombre,
      asignatura: concepto.asignatura,
      descripcion: concepto.descripcion ?? "",
    });
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setFormError(null);
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      if (editing) {
        await adminApi.updateConcepto(editing._id, form);
      } else {
        await adminApi.createConcepto(form);
      }
      closeModal();
      await fetchConceptos();
    } catch (err) {
      const data = err?.response?.data;
      let msg = data?.error ?? "Error al guardar.";
      if (data?.campos?.length) msg += ` Campos: ${data.campos.join(", ")}.`;
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  function openDelete(concepto) {
    setDeleteTarget(concepto);
    setDeleteError(null);
  }

  function closeDelete() {
    setDeleteTarget(null);
    setDeleteError(null);
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await adminApi.deleteConcepto(deleteTarget._id);
      closeDelete();
      await fetchConceptos();
    } catch (err) {
      const data = err?.response?.data;
      if (err?.response?.status === 409) {
        setDeleteError(
          `${data?.error ?? "No se puede eliminar."} (${data?.count ?? "?"} concepciones alternativas lo referencian)`
        );
      } else {
        setDeleteError(data?.error ?? "Error al eliminar.");
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-4xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-azuloscuro">Conceptos</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-[#00728A] text-white px-4 py-2 rounded-lg hover:bg-[#E72621] transition-colors text-sm font-medium"
        >
          <PlusIcon className="h-4 w-4" />
          Nuevo concepto
        </button>
      </div>

      {loading && <p className="text-gray-500 text-center py-12">Cargando...</p>}
      {!loading && error && (
        <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-4 mb-4">{error}</div>
      )}

      {!loading && !error && (
        <div className="overflow-x-auto rounded-xl border border-gray-200 shadow-sm">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Nombre</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Asignatura</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Descripción</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {conceptos.length === 0 && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">No hay conceptos todavía.</td>
                </tr>
              )}
              {conceptos.map((c) => (
                <tr key={c._id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800">{c.nombre}</td>
                  <td className="px-4 py-3 text-gray-600">{c.asignatura}</td>
                  <td className="px-4 py-3 text-gray-500 truncate max-w-xs">{c.descripcion || "—"}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEdit(c)}
                      className="inline-flex items-center gap-1 text-[#00728A] hover:text-[#E72621] text-sm mr-3"
                    >
                      <PencilIcon className="h-4 w-4" />
                      Editar
                    </button>
                    <button
                      onClick={() => openDelete(c)}
                      className="inline-flex items-center gap-1 text-gray-400 hover:text-[#E72621] text-sm"
                    >
                      <TrashIcon className="h-4 w-4" />
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Create/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-azuloscuro">
                {editing ? "Editar concepto" : "Nuevo concepto"}
              </h2>
              <button onClick={closeModal} className="text-gray-400 hover:text-[#E72621]">
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            {formError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm">
                {formError}
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Nombre <span className="text-rojo">*</span>
                </label>
                <input
                  type="text"
                  value={form.nombre}
                  onChange={(e) => setForm({ ...form, nombre: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Asignatura <span className="text-rojo">*</span>
                </label>
                <input
                  type="text"
                  value={form.asignatura}
                  onChange={(e) => setForm({ ...form, asignatura: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Descripción</label>
                <textarea
                  value={form.descripcion}
                  onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul resize-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={closeModal}
                  className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-sm bg-[#00728A] text-white rounded-lg hover:bg-[#E72621] transition-colors disabled:opacity-50"
                >
                  {saving ? "Guardando..." : "Guardar"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirm Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm mx-4 p-6">
            <h2 className="text-lg font-semibold text-azuloscuro mb-2">Eliminar concepto</h2>
            <p className="text-gray-600 text-sm mb-4">
              ¿Seguro que querés eliminar <strong>{deleteTarget.nombre}</strong>? Esta acción no se puede deshacer.
            </p>

            {deleteError && (
              <div className="bg-yellow-50 border border-yellow-300 text-yellow-800 rounded-lg p-3 mb-4 text-sm">
                {deleteError}
              </div>
            )}

            <div className="flex justify-end gap-3">
              <button
                onClick={closeDelete}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancelar
              </button>
              {!deleteError && (
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="px-4 py-2 text-sm bg-[#E72621] text-white rounded-lg hover:bg-red-700 transition-colors disabled:opacity-50"
                >
                  {deleting ? "Eliminando..." : "Eliminar"}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
