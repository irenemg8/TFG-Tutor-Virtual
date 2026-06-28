"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  IRESULTADOREPOSITORY                 |
            |  Port/interface defining the persistence contract for |
            |  Resultado entities. Adapters (Mongo, Postgres)       |
            |  implement it; the methods here just throw.           |
            |                                                       |
        ____|__________                                            |
   Obj -> | create() | -> Promise<Resultado>                       |
          -----------                                              |
        ____|_________________                                     |
   Txt -> | findByUserId() | -> Promise<[Resultado]>               |
          ------------------                                       |
        ____|_____________________________                         |
   Txt -> | findByUserIdWithExercise() | -> Promise<[Obj]>         |
          ----------------------------                             |
        ____|_______________________________                       |
   Txt -> | findCompletedExerciseIds() | -> Promise<[Txt]>         |
          ----------------------------                             |
        ____|__________________                                    |
   Obj -> | findByFilter() | -> Promise<[Resultado]>               |
          ------------------                                       |
        ____|________________________                              |
   Txt -> | getErrorTagsByUserId() | -> Promise<[Txt]>             |
          ------------------------                                 |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IResultadoRepository {
  /*
   Obj -> ____|__________
         | create() | -> Promise<Resultado>
          -----------
      Contract: persist a new resultado and resolve it. Abstract here.
  */
  async create(data) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_________________
         | findByUserId() | -> Promise<[Resultado]>
          ------------------
      Contract: resolve all results for a user, sorted by date DESC.
      Abstract here.
  */
  async findByUserId(userId) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_____________________________
         | findByUserIdWithExercise() | -> Promise<[Obj]>
          ----------------------------
      Contract: resolve results joined with their exercise data
      (replaces .populate()), each as { resultado, ejercicio }. Used by
      ProgresoService for the dashboard. Abstract here.
  */
  async findByUserIdWithExercise(userId) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_______________________________
         | findCompletedExerciseIds() | -> Promise<[Txt]>
          ----------------------------
      Contract: resolve the list of exercise IDs a user has completed.
      Abstract here.
  */
  async findCompletedExerciseIds(userId) {
    throw new Error("Not implemented");
  }

  /*
   Obj -> ____|__________________
         | findByFilter() | -> Promise<[Resultado]>
          ------------------
      Contract: resolve results matching a filter (for export).
      Abstract here.
  */
  async findByFilter(filter) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|________________________
         | getErrorTagsByUserId() | -> Promise<[Txt]>
          ------------------------
      Contract: resolve the distinct error tags (labels) from a user's
      past interactions. Used by the RAG pipeline for student history.
      Abstract here.
  */
  async getErrorTagsByUserId(userId) {
    throw new Error("Not implemented");
  }
}

module.exports = IResultadoRepository;
