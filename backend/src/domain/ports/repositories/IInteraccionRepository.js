"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                IINTERACCIONREPOSITORY                 |
            |  Port/interface defining the persistence contract for |
            |  Interaccion entities. Messages are handled by        |
            |  IMessageRepository, not here. Adapters (Mongo,       |
            |  Postgres) implement it; the methods here just throw. |
            |                                                       |
        ____|____________                                          |
   Txt -> | findById() | -> Promise<Interaccion>                   |
          -------------                                            |
        ____|__________                                            |
   Obj -> | create() | -> Promise<Interaccion>                     |
          -----------                                              |
        ____|________________                                      |
   Txt -> | deleteById() | -> Promise<void>                        |
          ----------------                                         |
        ____|__________                                            |
   Txt -> | exists() | -> Promise<T/F>                             |
          -----------                                              |
        ____|_________________                                     |
   Txt, Txt -> | existsForUser() | -> Promise<T/F>                |
              -----------------                                    |
        ____|__________________                                    |
   Txt, Date -> | updateEndTime() | -> Promise<void>              |
                -----------------                                  |
        ____|_________________                                     |
   Txt -> | findByUserId() | -> Promise<[Interaccion]>             |
          ------------------                                       |
        ____|________________________________                      |
   Txt, Txt -> | findLatestByExerciseAndUser() |                  |
              ---------------------------------                    |
              -> Promise<Interaccion | null>                       |
        ____|________________                                      |
   N -> | findRecent() | -> Promise<[Interaccion]>                 |
        ----------------                                           |
        ____|__________________                                    |
   Obj -> | findByFilter() | -> Promise<[Interaccion]>             |
          ------------------                                       |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IInteraccionRepository {
  /*
   Txt -> ____|____________
         | findById() | -> Promise<Interaccion>
          -------------
      Contract: resolve the interaccion with the given id. Abstract here.
  */
  async findById(id) {
    throw new Error("Not implemented");
  }

  /*
   Obj -> ____|__________
         | create() | -> Promise<Interaccion>
          -----------
      Contract: create an interaccion from { userId, exerciseId } and
      resolve it. Abstract here.
  */
  async create(data) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|________________
         | deleteById() | -> Promise<void>
          ----------------
      Contract: remove the interaccion with the given id. Abstract here.
  */
  async deleteById(id) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|__________
         | exists() | -> Promise<T/F>
          -----------
      Contract: resolve true when an interaccion with the id exists.
      Abstract here.
  */
  async exists(id) {
    throw new Error("Not implemented");
  }

  /*
   Txt, Txt -> ____|_________________
              | existsForUser() | -> Promise<T/F>
               -----------------
      Contract: resolve true when the interaccion exists AND belongs to
      the given user. Abstract here.
  */
  async existsForUser(id, userId) {
    throw new Error("Not implemented");
  }

  /*
   Txt, Date -> ____|_________________
                | updateEndTime() | -> Promise<void>
                 -----------------
      Contract: set the end time of the given interaccion. Abstract here.
  */
  async updateEndTime(id, endTime) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_________________
         | findByUserId() | -> Promise<[Interaccion]>
          ------------------
      Contract: resolve all interactions for a user, sorted by endTime
      DESC. Abstract here.
  */
  async findByUserId(userId) {
    throw new Error("Not implemented");
  }

  /*
   Txt, Txt -> ____|________________________________
              | findLatestByExerciseAndUser() | -> Promise<Interaccion | null>
               ---------------------------------
      Contract: resolve the latest interaction for a user + exercise
      pair, or null. Abstract here.
  */
  async findLatestByExerciseAndUser(exerciseId, userId) {
    throw new Error("Not implemented");
  }

  /*
   N -> ____|________________
       | findRecent() | -> Promise<[Interaccion]>
        ----------------
      Contract: resolve recent interactions (admin/test endpoint).
      Abstract here.
  */
  async findRecent(limit) {
    throw new Error("Not implemented");
  }

  /*
   Obj -> ____|__________________
         | findByFilter() | -> Promise<[Interaccion]>
          ------------------
      Contract: resolve interactions matching a filter (for export).
      Abstract here.
  */
  async findByFilter(filter) {
    throw new Error("Not implemented");
  }
}

module.exports = IInteraccionRepository;
