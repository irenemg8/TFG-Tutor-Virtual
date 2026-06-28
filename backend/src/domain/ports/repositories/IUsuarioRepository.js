"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                  IUSUARIOREPOSITORY                   |
            |  Port/interface defining the persistence contract for |
            |  Usuario entities. Adapters (Mongo, Postgres)         |
            |  implement it; the methods here just throw.           |
            |                                                       |
        ____|____________                                          |
   Txt -> | findById() | -> Promise<Usuario>                       |
          -------------                                            |
        ____|_________________                                     |
   Txt -> | findByUpvLogin() | -> Promise<Usuario | null>          |
          ------------------                                       |
        ____|___________________________                           |
   Txt, Obj, Obj -> | upsertByUpvLogin() | -> Promise<Usuario>    |
                    -------------------                            |
        ____|__________                                            |
   Obj -> | create() | -> Promise<Usuario>                         |
          -----------                                              |
        ____|________________                                      |
   Txt, Obj -> | updateById() | -> Promise<Usuario>               |
              ----------------                                     |
        ____|___________                                           |
        | findAll() | -> Promise<[Usuario]>                        |
        ------------                                                |
        ____|____________                                          |
   [Txt] -> | findByIds() | -> Promise<[Usuario]>                 |
            -------------                                          |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class IUsuarioRepository {
  /*
   Txt -> ____|____________
         | findById() | -> Promise<Usuario>
          -------------
      Contract: resolve the user with the given id. Abstract here.
  */
  async findById(id) {
    throw new Error("Not implemented");
  }

  /*
   Txt -> ____|_________________
         | findByUpvLogin() | -> Promise<Usuario | null>
          ------------------
      Contract: resolve the user with the given UPV login, or null.
      Abstract here.
  */
  async findByUpvLogin(upvLogin) {
    throw new Error("Not implemented");
  }

  /*
   Txt, Obj, Obj -> ____|___________________________
                   | upsertByUpvLogin() | -> Promise<Usuario>
                    -------------------
      Contract: create or update a user by upvLogin (used by CAS
      authentication). updateFields apply when the user exists;
      insertFields are set only on insert. Abstract here.
  */
  async upsertByUpvLogin(upvLogin, updateFields, insertFields) {
    throw new Error("Not implemented");
  }

  /*
   Obj -> ____|__________
         | create() | -> Promise<Usuario>
          -----------
      Contract: persist a new user and resolve it. Abstract here.
  */
  async create(userData) {
    throw new Error("Not implemented");
  }

  /*
   Txt, Obj -> ____|________________
              | updateById() | -> Promise<Usuario>
               ----------------
      Contract: update the user by id and resolve it. Abstract here.
  */
  async updateById(id, fields) {
    throw new Error("Not implemented");
  }

  /*
       ____|___________
      | findAll() | -> Promise<[Usuario]>
       ------------
      Contract: resolve the full list of users. Abstract here.
  */
  async findAll() {
    throw new Error("Not implemented");
  }

  /*
   [Txt] -> ____|____________
           | findByIds() | -> Promise<[Usuario]>
            -------------
      Contract: resolve all users for the given id list. Abstract here.
  */
  async findByIds(ids) {
    throw new Error("Not implemented");
  }
}

module.exports = IUsuarioRepository;
