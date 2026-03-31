// frontend/src/pages/admin/AdminConcepciones.jsx
import { useEffect, useState } from "react";
import { PlusIcon, PencilIcon, TrashIcon, XMarkIcon } from "@heroicons/react/24/outline";
import { adminApi } from "../../services/api";

const EMPTY_FORM = {
  codigo: "",
  titulo: "",
  descripcion: "",
  estrategiaSocratica: "",
  ejemplosError: [],
  conceptos: [],
};

export default function AdminConcepciones() {
  const [concepciones, setConcepciones] = useState([]);
  const [allConceptos, setAllConceptos] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  // New ejemplo input
  const [newEjemplo, setNewEjemplo] = useState("");

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const [concRes, conRes] = await Promise.all([
        adminApi.getConcepciones(),
        adminApi.getConceptos(),
      ]);
      setConcepciones(concRes.data.concepciones ?? []);
      setAllConceptos(conRes.data.conceptos ?? []);
    } catch (err) {
      setError(err?.response?.data?.error ?? "Error al cargar los datos.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { fetchData(); }, []);

  function openCreate() {
    setEditing(null);
    setForm(EMPTY_FORM);
    setNewEjemplo("");
    setFormError(null);
    setModalOpen(true);
  }

  function openEdit(concepcion) {
    setEditing(concepcion);
    setForm({
      codigo: concepcion.codigo,
      titulo: concepcion.titulo ?? "",
      descripcion: concepcion.descripcion,
      estrategiaSocratica: concepcion.estrategiaSocratica ?? "",
      ejemplosError: [...(concepcion.ejemplosError ?? [])],
      conceptos: (concepcion.conceptos ?? []).map((c) =>
        typeof c === "object" ? c._id : c
      ),
    });
    setNewEjemplo("");
    setFormError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setFormError(null);
  }

  function addEjemplo() {
    const trimmed = newEjemplo.trim();
    if (!trimmed) return;
    setForm((prev) => ({ ...prev, ejemplosError: [...prev.ejemplosError, trimmed] }));
    setNewEjemplo("");
  }

  function removeEjemplo(idx) {
    setForm((prev) => ({
      ...prev,
      ejemplosError: prev.ejemplosError.filter((_, i) => i !== idx),
    }));
  }

  function toggleConcepto(id) {
    setForm((prev) => {
      const already = prev.conceptos.includes(id);
      return {
        ...prev,
        conceptos: already
          ? prev.conceptos.filter((c) => c !== id)
          : [...prev.conceptos, id],
      };
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      if (editing) {
        await adminApi.updateConcepcion(editing._id, form);
      } else {
        await adminApi.createConcepcion(form);
      }
      closeModal();
      await fetchData();
    } catch (err) {
      const data = err?.response?.data;
      if (err?.response?.status === 409) {
        setFormError(data?.error ?? "El código ya existe.");
      } else {
        let msg = data?.error ?? "Error al guardar.";
        if (data?.campos?.length) msg += ` Campos: ${data.campos.join(", ")}.`;
        setFormError(msg);
      }
    } finally {
      setSaving(false);
    }
  }

  function openDelete(concepcion) {
    setDeleteTarget(concepcion);
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
      await adminApi.deleteConcepcion(deleteTarget._id);
      closeDelete();
      await fetchData();
    } catch (err) {
      const data = err?.response?.data;
      if (err?.response?.status === 409) {
        setDeleteError(
          `${data?.error ?? "No se puede eliminar."} (${data?.count ?? "?"} ejercicios lo referencian)`
        );
      } else {
        setDeleteError(data?.error ?? "Error al eliminar.");
      }
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-azuloscuro">Concepciones Alternativas</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-[#00728A] text-white px-4 py-2 rounded-lg hover:bg-[#E72621] transition-colors text-sm font-medium"
        >
          <PlusIcon className="h-4 w-4" />
          Nueva concepción
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Código</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Título</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Descripción</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Conceptos</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Errores</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {concepciones.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    No hay concepciones alternativas todavía.
                  </td>
                </tr>
              )}
              {concepciones.map((c) => (
                <tr key={c._id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-mono text-sm text-gray-800 font-medium">{c.codigo}</td>
                  <td className="px-4 py-3 text-gray-700 text-sm">{c.titulo || "—"}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm max-w-xs truncate">{c.descripcion}</td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {(c.conceptos ?? []).map((con) => (
                        <span
                          key={typeof con === "object" ? con._id : con}
                          className="inline-block bg-blue-100 text-azul text-xs px-2 py-0.5 rounded-full"
                        >
                          {typeof con === "object" ? con.nombre : con}
                        </span>
                      ))}
                      {(c.conceptos ?? []).length === 0 && (
                        <span className="text-gray-400 text-xs">—</span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-500 text-sm">{(c.ejemplosError ?? []).length}</td>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg mx-4 my-8 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-azuloscuro">
                {editing ? "Editar concepción" : "Nueva concepción alternativa"}
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
                  Código <span className="text-rojo">*</span>
                </label>
                <input
                  type="text"
                  value={form.codigo}
                  onChange={(e) => setForm({ ...form, codigo: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-azul"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Título</label>
                <input
                  type="text"
                  value={form.titulo}
                  onChange={(e) => setForm({ ...form, titulo: e.target.value })}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul"
                  placeholder="Nombre corto de la concepción"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Descripción <span className="text-rojo">*</span>
                </label>
                <textarea
                  value={form.descripcion}
                  onChange={(e) => setForm({ ...form, descripcion: e.target.value })}
                  rows={3}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul resize-none"
                  required
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Estrategia Socrática</label>
                <textarea
                  value={form.estrategiaSocratica}
                  onChange={(e) => setForm({ ...form, estrategiaSocratica: e.target.value })}
                  rows={2}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Ejemplos de error</label>
                <div className="space-y-2 mb-2">
                  {form.ejemplosError.map((ej, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <span className="flex-1 text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded px-2 py-1">
                        {ej}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeEjemplo(idx)}
                        className="text-gray-400 hover:text-[#E72621]"
                      >
                        <XMarkIcon className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={newEjemplo}
                    onChange={(e) => setNewEjemplo(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addEjemplo(); } }}
                    placeholder="Añadir ejemplo de error..."
                    className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul"
                  />
                  <button
                    type="button"
                    onClick={addEjemplo}
                    className="px-3 py-2 bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 text-sm"
                  >
                    <PlusIcon className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Conceptos relacionados</label>
                {allConceptos.length === 0 && (
                  <p className="text-sm text-gray-400">No hay conceptos disponibles.</p>
                )}
                <div className="flex flex-wrap gap-2 max-h-40 overflow-y-auto border border-gray-200 rounded-lg p-2">
                  {allConceptos.map((c) => {
                    const selected = form.conceptos.includes(c._id);
                    return (
                      <button
                        key={c._id}
                        type="button"
                        onClick={() => toggleConcepto(c._id)}
                        className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                          selected
                            ? "bg-[#00728A] text-white border-[#00728A]"
                            : "bg-white text-gray-600 border-gray-300 hover:border-[#00728A]"
                        }`}
                      >
                        {c.nombre} — {c.asignatura}
                      </button>
                    );
                  })}
                </div>
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
            <h2 className="text-lg font-semibold text-azuloscuro mb-2">Eliminar concepción</h2>
            <p className="text-gray-600 text-sm mb-4">
              ¿Seguro que querés eliminar <strong>{deleteTarget.codigo}</strong>? Esta acción no se puede deshacer.
            </p>

            {deleteError && (
              <div className="bg-red-50 border border-red-200 text-red-700 rounded-lg p-3 mb-4 text-sm">
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
