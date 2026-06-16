"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                        USUARIO                        |
            |  Domain entity representing an authenticated user and   |
            |  their role within the platform.                       |
        ____|________________                                       |
   Obj -> | constructor() | -> Usuario              (writes attrs)  |
          -----------------                                         |
            |                                                       |
            |   id: Txt            upvLogin: Txt                    |
            |   email: Txt         firstName: Txt                   |
            |   lastName: Txt      nationalId: Txt                  |
            |   groups: [Txt]      role: Txt                        |
            |   lastLoginAt: Date | null                            |
            |   createdAt: Date    updatedAt: Date                  |
        ____|___________                                            |
        | isStudent() | -> T/F                       (reads attrs)  |
        --------------                                              |
        ____|___________                                            |
        | isTeacher() | -> T/F                       (reads attrs)  |
        --------------                                              |
        ____|_________                                              |
        | isAdmin() | -> T/F                         (reads attrs)  |
        ------------                                                |
        ____|__________                                             |
   Txt -> | hasRole() | -> T/F                       (reads attrs)  |
          -----------                                               |
        ____|___________                                            |
        | toJSON() | -> Obj                          (reads attrs)  |
        ------------                                                |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
class Usuario {
  /*
   Obj -> ____|________________
         | constructor() | -> Usuario    (writes attributes id (Txt), upvLogin (Txt),
          -----------------               email (Txt), firstName (Txt), lastName (Txt),
                                          nationalId (Txt), groups ([Txt]), role (Txt),
                                          lastLoginAt (Date|null), createdAt (Date),
                                          updatedAt (Date))
      Builds the user from a plain props object. `role` defaults to "alumno".
  */
  constructor(props) {
    this.id = props.id;
    this.upvLogin = props.upvLogin;
    this.email = props.email || "";
    this.firstName = props.firstName || "";
    this.lastName = props.lastName || "";
    this.nationalId = props.nationalId || "";
    this.groups = props.groups || [];
    this.role = props.role || "alumno";
    this.lastLoginAt = props.lastLoginAt || null;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  /*
       ____|___________
      | isStudent() | -> T/F    (reads attribute role (Txt))
       --------------
      True when the user role is "alumno".
  */
  isStudent() {
    return this.role === "alumno";
  }

  /*
       ____|___________
      | isTeacher() | -> T/F    (reads attribute role (Txt))
       --------------
      True when the user role is "profesor".
  */
  isTeacher() {
    return this.role === "profesor";
  }

  /*
       ____|_________
      | isAdmin() | -> T/F    (reads attribute role (Txt))
       ------------
      True when the user role is "admin".
  */
  isAdmin() {
    return this.role === "admin";
  }

  /*
   Txt -> ____|__________
         | hasRole() | -> T/F    (reads attribute role (Txt))
          -----------
      True when the user role equals the given role.
  */
  hasRole(role) {
    return this.role === role;
  }

  /*
       ____|___________
      | toJSON() | -> Obj    (reads attributes id (Txt), upvLogin (Txt),
       ------------          email (Txt), firstName (Txt), lastName (Txt),
                             nationalId (Txt), groups ([Txt]), role (Txt),
                             lastLoginAt (Date|null), createdAt (Date), updatedAt (Date))
      Serializes to the legacy Mongo shape consumed by the frontend.
  */
  toJSON() {
    return {
      _id: this.id,
      id: this.id,
      upvLogin: this.upvLogin,
      email: this.email,
      nombre: this.firstName,
      apellidos: this.lastName,
      dni: this.nationalId,
      grupos: this.groups,
      rol: this.role,
      lastLoginAt: this.lastLoginAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}

module.exports = Usuario;
