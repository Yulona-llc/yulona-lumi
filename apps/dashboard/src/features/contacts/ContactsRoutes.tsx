import { Route, Routes } from "react-router";
import ContactList from "./ContactList";
import ContactProfile from "./ContactProfile";

export default function ContactsRoutes() {
  return (
    <Routes>
      <Route index element={<ContactList />} />
      <Route path=":id" element={<ContactProfile />} />
    </Routes>
  );
}
