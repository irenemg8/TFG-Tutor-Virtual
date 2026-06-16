"use strict";

/*------------------------------------------------------------------------------
            _________________________________________________________
            |                          ROLES                        |
            |  Module of role definitions and the permission         |
            |  hierarchy. alumno reads own data; profesor adds any   |
            |  student's data, exercise CRUD and export; admin adds  |
            |  user CRUD.                                            |
            |                                                       |
            |   Txt, Txt -> | hasMinRole() | -> T/F                 |
            |                                                       |
            |_______________________________________________________|
------------------------------------------------------------------------------*/
const ROLES = {
  ALUMNO: "alumno",
  PROFESOR: "profesor",
  ADMIN: "admin",
};

const ROLE_HIERARCHY = {
  alumno: 0,
  profesor: 1,
  admin: 2,
};

/*
   Txt, Txt -> ____|______________
              | hasMinRole() | -> T/F
               --------------
      True when userRole sits at or above requiredRole in the hierarchy.
*/
function hasMinRole(userRole, requiredRole) {
  return (ROLE_HIERARCHY[userRole] || 0) >= (ROLE_HIERARCHY[requiredRole] || 0);
}

module.exports = { ROLES, ROLE_HIERARCHY, hasMinRole };
