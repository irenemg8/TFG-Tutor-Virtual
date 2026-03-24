// frontend/src/pages/admin/AdminEjercicios.jsx
import { useEffect, useState, useRef } from "react";
import { PlusIcon, PencilIcon, TrashIcon, XMarkIcon, PhotoIcon } from "@heroicons/react/24/outline";
import { adminApi } from "../../services/api";

const EMPTY_FORM = {
  titulo: "",
  enunciado: "",
  asignatura: "",
  concepto: "",
  nivel: 1,
  imagen: "",
  CA: "",
  concepciones_alternativas: [],
  tutorContext: {
    objetivo: "",
    netlist: "",
    modoExperto: false,
    ac_refs: "",
    respuestaCorrecta: "",
  },
};

export default function AdminEjercicios() {
  const [ejercicios, setEjercicios] = useState([]);
  const [allConcepciones, setAllConcepciones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Modal state
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState(null);
  const [saving, setSaving] = useState(false);

  // Image upload
  const [uploadError, setUploadError] = useState(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef(null);

  const [filters, setFilters] = useState({ asignatura: "", concepto: "", nivel: "" });

  // Delete confirm
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleting, setDeleting] = useState(false);

  async function fetchData() {
    setLoading(true);
    setError(null);
    try {
      const [ejRes, concRes] = await Promise.all([
        adminApi.getEjercicios(),
        adminApi.getConcepciones(),
      ]);
      setEjercicios(ejRes.data.ejercicios ?? []);
      setAllConcepciones(concRes.data.concepciones ?? []);
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
    setFormError(null);
    setUploadError(null);
    setModalOpen(true);
  }

  function openEdit(ejercicio) {
    setEditing(ejercicio);
    setForm({
      titulo: ejercicio.titulo ?? "",
      enunciado: ejercicio.enunciado ?? "",
      asignatura: ejercicio.asignatura ?? "",
      concepto: ejercicio.concepto ?? "",
      nivel: ejercicio.nivel ?? 1,
      imagen: ejercicio.imagen ?? "",
      CA: ejercicio.CA ?? "",
      concepciones_alternativas: (ejercicio.concepciones_alternativas ?? []).map((c) =>
        typeof c === "object" ? c._id : c
      ),
      tutorContext: {
        objetivo: ejercicio.tutorContext?.objetivo ?? "",
        netlist: ejercicio.tutorContext?.netlist ?? "",
        modoExperto: ejercicio.tutorContext?.modoExperto ?? false,
        ac_refs: ejercicio.tutorContext?.ac_refs ?? "",
        respuestaCorrecta: ejercicio.tutorContext?.respuestaCorrecta ?? "",
      },
    });
    setFormError(null);
    setUploadError(null);
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditing(null);
    setFormError(null);
    setUploadError(null);
  }

  function updateTutorContext(field, value) {
    setForm((prev) => ({
      ...prev,
      tutorContext: { ...prev.tutorContext, [field]: value },
    }));
  }

  function toggleConcepcion(id) {
    setForm((prev) => {
      const already = prev.concepciones_alternativas.includes(id);
      return {
        ...prev,
        concepciones_alternativas: already
          ? prev.concepciones_alternativas.filter((c) => c !== id)
          : [...prev.concepciones_alternativas, id],
      };
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormError(null);
    setSaving(true);
    try {
      if (editing) {
        await adminApi.updateEjercicio(editing._id, form);
      } else {
        await adminApi.createEjercicio(form);
      }
      closeModal();
      await fetchData();
    } catch (err) {
      const data = err?.response?.data;
      let msg = data?.error ?? "Error al guardar.";
      if (data?.campos?.length) msg += ` Campos: ${data.campos.join(", ")}.`;
      setFormError(msg);
    } finally {
      setSaving(false);
    }
  }

  async function handleImageUpload(e) {
    const file = e.target.files?.[0];
    if (!file || !editing) return;
    setUploadError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("imagen", file);
      const res = await adminApi.uploadImagen(editing._id, formData);
      const newFilename = res.data.imagen;
      setForm((prev) => ({ ...prev, imagen: newFilename }));
      setEditing((prev) => ({ ...prev, imagen: newFilename }));
      // Reset file input
      if (fileInputRef.current) fileInputRef.current.value = "";
    } catch (err) {
      const data = err?.response?.data;
      setUploadError(data?.error ?? "Error al subir la imagen.");
    } finally {
      setUploading(false);
    }
  }

  function openDelete(ejercicio) {
    setDeleteTarget(ejercicio);
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
      await adminApi.deleteEjercicio(deleteTarget._id);
      closeDelete();
      await fetchData();
    } catch (err) {
      const data = err?.response?.data;
      setDeleteError(data?.error ?? "Error al eliminar.");
    } finally {
      setDeleting(false);
    }
  }

  const filtered = ejercicios.filter((ej) => {
    const matchAsignatura = !filters.asignatura || ej.asignatura.toLowerCase().includes(filters.asignatura.toLowerCase());
    const matchConcepto = !filters.concepto || ej.concepto.toLowerCase().includes(filters.concepto.toLowerCase());
    const matchNivel = !filters.nivel || String(ej.nivel) === String(filters.nivel);
    return matchAsignatura && matchConcepto && matchNivel;
  });

  return (
    <div className="max-w-5xl mx-auto px-4 py-10">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-azuloscuro">Ejercicios</h1>
        <button
          onClick={openCreate}
          className="flex items-center gap-2 bg-[#00728A] text-white px-4 py-2 rounded-lg hover:bg-[#E72621] transition-colors text-sm font-medium"
        >
          <PlusIcon className="h-4 w-4" />
          Nuevo ejercicio
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-4">
        <input
          type="text"
          placeholder="Filtrar por asignatura..."
          value={filters.asignatura}
          onChange={(e) => setFilters({ ...filters, asignatura: e.target.value })}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00728A] w-48"
        />
        <input
          type="text"
          placeholder="Filtrar por concepto..."
          value={filters.concepto}
          onChange={(e) => setFilters({ ...filters, concepto: e.target.value })}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00728A] w-48"
        />
        <input
          type="number"
          placeholder="Nivel"
          value={filters.nivel}
          min={1}
          onChange={(e) => setFilters({ ...filters, nivel: e.target.value })}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#00728A] w-24"
        />
        {(filters.asignatura || filters.concepto || filters.nivel) && (
          <button
            onClick={() => setFilters({ asignatura: "", concepto: "", nivel: "" })}
            className="text-sm text-gray-400 hover:text-[#E72621] px-2"
          >
            Limpiar filtros
          </button>
        )}
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
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Título</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Asignatura</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Concepto</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Nivel</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Versión</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-100">
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                    {ejercicios.length > 0 && filtered.length === 0
                      ? "No hay ejercicios que coincidan con los filtros."
                      : "No hay ejercicios todavía."}
                  </td>
                </tr>
              )}
              {filtered.map((ej) => (
                <tr key={ej._id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 font-medium text-gray-800 max-w-xs truncate">{ej.titulo}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{ej.asignatura}</td>
                  <td className="px-4 py-3 text-gray-600 text-sm">{ej.concepto}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center justify-center h-6 w-6 rounded-full bg-blue-100 text-azul text-xs font-semibold">
                      {ej.nivel}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-gray-400 text-sm">{ej.tutorContext?.version ?? 1}</td>
                  <td className="px-4 py-3 text-right">
                    <button
                      onClick={() => openEdit(ej)}
                      className="inline-flex items-center gap-1 text-[#00728A] hover:text-[#E72621] text-sm mr-3"
                    >
                      <PencilIcon className="h-4 w-4" />
                      Editar
                    </button>
                    <button
                      onClick={() => openDelete(ej)}
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
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 overflow-y-auto pt-8 pb-8">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold text-azuloscuro">
                {editing ? "Editar ejercicio" : "Nuevo ejercicio"}
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
              {/* Required fields */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Título <span className="text-rojo">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.titulo}
                    onChange={(e) => setForm({ ...form, titulo: e.target.value })}
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
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Concepto <span className="text-rojo">*</span>
                  </label>
                  <input
                    type="text"
                    value={form.concepto}
                    onChange={(e) => setForm({ ...form, concepto: e.target.value })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul"
                    required
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">
                    Nivel <span className="text-rojo">*</span>
                  </label>
                  <input
                    type="number"
                    min={1}
                    value={form.nivel}
                    onChange={(e) => setForm({ ...form, nivel: parseInt(e.target.value, 10) || 1 })}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul"
                    required
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Enunciado <span className="text-rojo">*</span>
                </label>
                <textarea
                  value={form.enunciado}
                  onChange={(e) => setForm({ ...form, enunciado: e.target.value })}
                  rows={4}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-azul resize-none"
                  required
                />
              </div>

              {/* TutorContext */}
              <details className="border border-gray-200 rounded-lg">
                <summary className="px-4 py-2 text-sm font-medium text-gray-700 cursor-pointer hover:bg-gray-50">
                  Configuración del tutor (tutorContext)
                </summary>
                <div className="px-4 py-3 space-y-3">
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Objetivo</label>
                    <textarea
                      value={form.tutorContext.objetivo}
                      onChange={(e) => updateTutorContext("objetivo", e.target.value)}
                      rows={2}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-azul resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Netlist</label>
                    <textarea
                      value={form.tutorContext.netlist}
                      onChange={(e) => updateTutorContext("netlist", e.target.value)}
                      rows={2}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-azul resize-none"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">AC Refs</label>
                    <input
                      type="text"
                      value={form.tutorContext.ac_refs}
                      onChange={(e) => updateTutorContext("ac_refs", e.target.value)}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-azul"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-medium text-gray-600 mb-1">Respuesta Correcta</label>
                    <textarea
                      value={form.tutorContext.respuestaCorrecta}
                      onChange={(e) => updateTutorContext("respuestaCorrecta", e.target.value)}
                      rows={2}
                      className="w-full border border-gray-200 rounded px-2 py-1 text-sm focus:outline-none focus:ring-1 focus:ring-azul resize-none"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      id="modoExperto"
                      type="checkbox"
                      checked={form.tutorContext.modoExperto}
                      onChange={(e) => updateTutorContext("modoExperto", e.target.checked)}
                      className="h-4 w-4 text-azul rounded"
                    />
                    <label htmlFor="modoExperto" className="text-xs text-gray-600">Modo Experto</label>
                  </div>
                </div>
              </details>

              {/* Image upload — only in edit mode */}
              {editing && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Imagen</label>
                  {form.imagen && (
                    <div className="mb-2 flex items-center gap-3">
                      <img
                        src={`/static/${form.imagen}`}
                        alt="Imagen actual"
                        className="h-16 w-16 object-cover rounded border border-gray-200"
                        onError={(e) => { e.currentTarget.style.display = "none"; }}
                      />
                      <span className="text-xs text-gray-400">{form.imagen}</span>
                    </div>
                  )}
                  {uploadError && (
                    <div className="bg-red-50 border border-red-200 text-red-700 rounded p-2 text-xs mb-2">
                      {uploadError}
                    </div>
                  )}
                  <label className="flex items-center gap-2 cursor-pointer w-fit">
                    <span className="flex items-center gap-2 px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-lg hover:bg-gray-200 border border-gray-300">
                      <PhotoIcon className="h-4 w-4" />
                      {uploading ? "Subiendo..." : "Subir imagen"}
                    </span>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/jpeg,image/png,image/gif,image/webp"
                      onChange={handleImageUpload}
                      disabled={uploading}
                      className="sr-only"
                    />
                  </label>
                  <p className="text-xs text-gray-400 mt-1">JPG, PNG, GIF o WebP — máx. 5 MB</p>
                </div>
              )}

              {/* Concepciones alternativas multi-select */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Concepciones alternativas
                </label>
                {allConcepciones.length === 0 && (
                  <p className="text-sm text-gray-400">No hay concepciones disponibles.</p>
                )}
                <div className="flex flex-wrap gap-2 max-h-36 overflow-y-auto border border-gray-200 rounded-lg p-2">
                  {allConcepciones.map((c) => {
                    const selected = form.concepciones_alternativas.includes(c._id);
                    return (
                      <button
                        key={c._id}
                        type="button"
                        onClick={() => toggleConcepcion(c._id)}
                        className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                          selected
                            ? "bg-[#E72621] text-white border-[#E72621]"
                            : "bg-white text-gray-600 border-gray-300 hover:border-[#E72621]"
                        }`}
                      >
                        {c.codigo}
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
            <h2 className="text-lg font-semibold text-azuloscuro mb-2">Eliminar ejercicio</h2>
            <p className="text-gray-600 text-sm mb-4">
              ¿Seguro que querés eliminar <strong>{deleteTarget.titulo}</strong>? Esta acción no se puede deshacer.
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
